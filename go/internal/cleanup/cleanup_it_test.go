//go:build integration

package cleanup_test

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/cleanup"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

// scoped narrows the inventory to this test's project. The test VM is
// shared by every agent's integration tests, whose managed resources would
// otherwise look like orphans to a pruner that only knows this test's
// desired state.
type scoped struct {
	*jobrun.Docker
	project string
}

func (s scoped) mine(labels map[string]string) bool { return labels[docker.LabelProject] == s.project }

func (s scoped) ContainersWithSize(ctx context.Context) ([]jobrun.Container, error) {
	all, err := s.Docker.ContainersWithSize(ctx)
	return slices.DeleteFunc(all, func(c jobrun.Container) bool { return !s.mine(c.Labels) }), err
}

func (s scoped) Images(ctx context.Context) ([]jobrun.Image, error) {
	all, err := s.Docker.Images(ctx)
	return slices.DeleteFunc(all, func(i jobrun.Image) bool { return !s.mine(i.Labels) }), err
}

func (s scoped) Volumes(ctx context.Context) ([]jobrun.Volume, error) {
	all, err := s.Docker.Volumes(ctx)
	return slices.DeleteFunc(all, func(v jobrun.Volume) bool { return !s.mine(v.Labels) }), err
}

func (s scoped) Networks(ctx context.Context) ([]jobrun.Network, error) {
	all, err := s.Docker.Networks(ctx)
	return slices.DeleteFunc(all, func(n jobrun.Network) bool { return !strings.Contains(n.Name, s.project) }), err
}

// Prune removes our orphans and never anything without the managed label:
// an unlabeled container, image, volume and network that look exactly
// like orphans survive.
func TestPruneLeavesUnlabeledResourcesAlone(t *testing.T) {
	e := itest.New(t)
	ctx := e.Ctx(10 * time.Minute)
	cli := e.D.Client()
	e.Pull("busybox:1.37")
	p := e.Project
	gone := p + "gone"

	ourLabels := func() map[string]string {
		return map[string]string{docker.LabelManaged: "true", docker.LabelProject: p, docker.LabelService: gone, docker.LabelGeneration: "1"}
	}
	// Look-alikes: the same labels minus seylo.managed.
	theirLabels := func() map[string]string {
		m := ourLabels()
		delete(m, docker.LabelManaged)
		return m
	}
	mkContainer := func(name string, labels map[string]string) string {
		res, err := cli.ContainerCreate(ctx, client.ContainerCreateOptions{Name: name, Config: &container.Config{Image: "busybox:1.37", Cmd: []string{"true"}, Labels: labels}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = cli.ContainerRemove(context.Background(), res.ID, client.ContainerRemoveOptions{Force: true})
		})
		return res.ID
	}
	ours := mkContainer(p+"-ours", ourLabels())
	theirs := mkContainer(p+"-theirs", theirLabels())

	mkImage := func(tag string, labels map[string]string) string {
		var changes []string
		for k, v := range labels {
			changes = append(changes, "LABEL "+k+"="+v)
		}
		res, err := cli.ContainerCommit(ctx, theirs, client.ContainerCommitOptions{Reference: tag, Changes: changes})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = cli.ImageRemove(context.Background(), res.ID, client.ImageRemoveOptions{Force: true}) })
		return res.ID
	}
	ourImage := mkImage("jbit/"+p+":ours", ourLabels())
	theirImage := mkImage("jbit/"+p+":theirs", theirLabels())

	mkVolume := func(name string, labels map[string]string) {
		if _, err := cli.VolumeCreate(ctx, client.VolumeCreateOptions{Name: name, Labels: labels}); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = cli.VolumeRemove(context.Background(), name, client.VolumeRemoveOptions{Force: true}) })
	}
	mkVolume(p+"-ours", ourLabels())
	mkVolume(p+"-theirs", theirLabels())

	mkNetwork := func(name string, labels map[string]string) {
		if _, err := cli.NetworkCreate(ctx, name, client.NetworkCreateOptions{Driver: "bridge", Labels: labels}); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = cli.NetworkRemove(context.Background(), name, client.NetworkRemoveOptions{}) })
	}
	mkNetwork(docker.ProjectNetwork(p+"old"), map[string]string{docker.LabelManaged: "true"})
	mkNetwork(docker.ProjectNetwork(p+"foreign"), map[string]string{})

	// A live service keeps its container, data and network.
	live := e.Spec("live", "live", "busybox:1.37")
	live.Container = &agentv1.ContainerConfig{Command: []string{"sleep", "3600"}}
	e.StartService(live)
	liveDir, _ := e.Layout.ServiceDir(live.GetId())
	goneDir, _ := e.Layout.ServiceDir(gone)
	for _, d := range []string{liveDir, goneDir} {
		if err := os.MkdirAll(filepath.Join(d, "volumes", "data"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "volumes", "data", "f"), make([]byte, 4096), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	desired := &agentv1.DesiredState{Revision: 3, Services: []*agentv1.ServiceSpec{live}, Networks: []*agentv1.ProjectNetwork{{ProjectId: p}}}
	pruner := cleanup.NewLocal(cleanup.Options{Docker: scoped{e.D, p}, Layout: e.Layout, Desired: func() *agentv1.DesiredState { return desired }})
	req := &agentv1.PruneRequest{Images: true, StoppedContainers: true, OrphanedServiceData: true, BuildCache: true, DryRun: true}

	dry, err := pruner.Prune(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("dry run (%d bytes):\n%s", dry.GetReclaimedBytes(), strings.Join(dry.GetRemoved(), "\n"))
	mentions := func(lines []string, s string) bool {
		return slices.ContainsFunc(lines, func(l string) bool { return strings.Contains(l, s) })
	}
	for _, want := range []string{p + "-ours", "jbit/" + p + ":ours", "volume " + p + "-ours", docker.ProjectNetwork(p + "old"), "data " + gone} {
		if !mentions(dry.GetRemoved(), want) {
			t.Errorf("dry run misses %q", want)
		}
	}
	for _, never := range []string{p + "-theirs", ":theirs", docker.ProjectNetwork(p + "foreign"), "data " + live.GetId(), "container " + docker.ContainerName(live.GetId(), 1, 0)} {
		if mentions(dry.GetRemoved(), never) {
			t.Errorf("dry run would remove %q", never)
		}
	}
	if _, err := cli.ContainerInspect(ctx, ours, client.ContainerInspectOptions{}); err != nil {
		t.Fatal("dry run removed a container")
	}

	req.DryRun = false
	res, err := pruner.Prune(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("run:\n%s", strings.Join(res.GetRemoved(), "\n"))
	if mentions(res.GetRemoved(), "not removed") {
		t.Errorf("some removals failed: %v", res.GetRemoved())
	}
	if _, err := cli.ContainerInspect(ctx, ours, client.ContainerInspectOptions{}); err == nil {
		t.Error("our orphan container survived")
	}
	if _, err := cli.ImageInspect(ctx, ourImage); err == nil {
		t.Error("our orphan image survived")
	}
	if _, err := cli.VolumeInspect(ctx, p+"-ours", client.VolumeInspectOptions{}); err == nil {
		t.Error("our orphan volume survived")
	}
	if _, err := cli.NetworkInspect(ctx, docker.ProjectNetwork(p+"old"), client.NetworkInspectOptions{}); err == nil {
		t.Error("our orphan network survived")
	}
	if _, err := os.Stat(goneDir); !os.IsNotExist(err) {
		t.Error("orphaned service data survived")
	}
	// Never touched.
	if _, err := cli.ContainerInspect(ctx, theirs, client.ContainerInspectOptions{}); err != nil {
		t.Error("unlabeled container removed")
	}
	if _, err := cli.ImageInspect(ctx, theirImage); err != nil {
		t.Error("unlabeled image removed")
	}
	if _, err := cli.VolumeInspect(ctx, p+"-theirs", client.VolumeInspectOptions{}); err != nil {
		t.Error("unlabeled volume removed")
	}
	if _, err := cli.NetworkInspect(ctx, docker.ProjectNetwork(p+"foreign"), client.NetworkInspectOptions{}); err != nil {
		t.Error("unlabeled network removed")
	}
	if _, err := os.Stat(liveDir); err != nil {
		t.Error("live service data removed")
	}
	if c, found, _ := e.D.Inspect(ctx, docker.ContainerName(live.GetId(), 1, 0)); !found || !c.Running {
		t.Error("live service container touched")
	}

	// The unscoped Remove calls refuse unlabeled resources on their own.
	if err := e.D.RemoveContainer(ctx, theirs); err == nil {
		t.Error("RemoveContainer accepted an unlabeled container")
	}
	if err := e.D.RemoveImage(ctx, theirImage); err == nil {
		t.Error("RemoveImage accepted an unlabeled image")
	}
	if err := e.D.RemoveVolume(ctx, p+"-theirs"); err == nil {
		t.Error("RemoveVolume accepted an unlabeled volume")
	}
	if err := e.D.RemoveNetwork(ctx, docker.ProjectNetwork(p+"foreign")); err == nil {
		t.Error("RemoveNetwork accepted an unlabeled network")
	}
}
