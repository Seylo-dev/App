//go:build integration

package jobrun_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/client"

	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

const alpine = "alpine:3.22"

func spec(e *itest.Env, name string, cmd ...string) jobrun.Spec {
	return jobrun.Spec{
		Name:       name,
		Image:      alpine,
		Entrypoint: []string{"/bin/sh", "-c"},
		Cmd:        cmd,
		Labels:     jobrun.Labels(jobrun.Owner{ServiceID: e.Project + "s", ProjectID: e.Project, Kind: "app"}, jobrun.RoleCron, nil),
		Network:    e.Network,
	}
}

func TestRunStreamsStdioAndExitCode(t *testing.T) {
	e := itest.New(t)
	ctx := e.Ctx(5 * time.Minute)
	in := strings.Repeat("0123456789", 500000) // 5 MB through stdin and back
	var out, errOut bytes.Buffer
	res, err := e.D.Run(ctx, spec(e, e.Project+"-cat", `cat; echo bye >&2; exit 3`), jobrun.IO{Stdin: strings.NewReader(in), Stdout: &out, Stderr: &errOut})
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode != 3 || out.String() != in || strings.TrimSpace(errOut.String()) != "bye" {
		t.Fatalf("exit %d, %d bytes out (want %d), stderr %q", res.ExitCode, out.Len(), len(in), errOut.String())
	}
	if _, found, _ := e.D.Inspect(ctx, e.Project+"-cat"); found {
		t.Fatal("one-off container not removed")
	}
}

func TestRunTimeoutKillsAndRemoves(t *testing.T) {
	e := itest.New(t)
	ctx, cancel := context.WithTimeout(e.Ctx(5*time.Minute), 3*time.Second)
	defer cancel()
	start := time.Now()
	_ = e.D.EnsureImage(e.Ctx(5*time.Minute), alpine, nil)
	_, err := e.D.Run(ctx, spec(e, e.Project+"-sleep", "sleep 600"), jobrun.IO{})
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 60*time.Second {
		t.Fatalf("err = %v after %v", err, time.Since(start))
	}
	if _, found, _ := e.D.Inspect(e.Ctx(time.Minute), e.Project+"-sleep"); found {
		t.Fatal("timed-out container not removed")
	}
}

type failingWriter struct{ n int }

func (f *failingWriter) Write(p []byte) (int, error) {
	f.n += len(p)
	if f.n > 1<<20 {
		return 0, errors.New("upload broke")
	}
	return len(p), nil
}

func TestRunStopsWhenOutputFails(t *testing.T) {
	e := itest.New(t)
	start := time.Now()
	_, err := e.D.Run(e.Ctx(5*time.Minute), spec(e, e.Project+"-yes", "yes"), jobrun.IO{Stdout: &failingWriter{}})
	if err == nil || !strings.Contains(err.Error(), "upload broke") || time.Since(start) > 2*time.Minute {
		t.Fatalf("err = %v after %v", err, time.Since(start))
	}
}

func TestEnsureRunningRecreatesOnChange(t *testing.T) {
	e := itest.New(t)
	ctx := e.Ctx(5 * time.Minute)
	s := spec(e, e.Project+"-helper", "echo v1; sleep 600")
	s.KeepLogs = true
	c1, err := e.D.EnsureRunning(ctx, s)
	if err != nil || !c1.Running || !c1.IPs[e.Network].IsValid() {
		t.Fatalf("first = %+v, %v", c1, err)
	}
	if c1.Labels[docker.LabelManaged] != "true" || c1.Labels[jobrun.LabelSpecHash] == "" {
		t.Fatalf("labels = %v", c1.Labels)
	}
	same, err := e.D.EnsureRunning(ctx, s)
	if err != nil || same.ID != c1.ID {
		t.Fatalf("unchanged spec recreated: %v", err)
	}
	if err := e.D.Stop(ctx, c1.ID, time.Second); err != nil {
		t.Fatal(err)
	}
	restarted, err := e.D.EnsureRunning(ctx, s)
	if err != nil || restarted.ID != c1.ID || !restarted.Running {
		t.Fatalf("stopped helper not restarted in place: %+v %v", restarted, err)
	}
	s.Cmd = []string{"echo v2; sleep 600"}
	c2, err := e.D.EnsureRunning(ctx, s)
	if err != nil || c2.ID == c1.ID {
		t.Fatalf("changed spec not recreated: %v", err)
	}
	e.Eventually("v2 in logs", 30*time.Second, func() bool {
		rc, err := e.D.Logs(ctx, c2.ID, false)
		if err != nil {
			return false
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		return strings.Contains(string(b), "v2")
	})
}

// volumeImage commits alpine with a VOLUME line, like most database images
// have, so every container made from it gets an anonymous volume.
func volumeImage(t *testing.T, e *itest.Env) string {
	t.Helper()
	ctx := e.Ctx(5 * time.Minute)
	if err := e.D.EnsureImage(ctx, alpine, nil); err != nil {
		t.Fatal(err)
	}
	base, err := e.D.Client().ContainerCreate(ctx, client.ContainerCreateOptions{Config: &container.Config{Image: alpine, Cmd: []string{"true"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = e.D.Client().ContainerRemove(context.Background(), base.ID, client.ContainerRemoveOptions{Force: true})
	}()
	ref := "seylo-it-volume:" + e.Project
	if _, err := e.D.Client().ContainerCommit(ctx, base.ID, client.ContainerCommitOptions{Reference: ref, Changes: []string{"VOLUME /data"}}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = e.D.Client().ImageRemove(context.Background(), ref, client.ImageRemoveOptions{Force: true, PruneChildren: true})
	})
	return ref
}

// anonymousVolumes returns the names of the volumes Docker made for the
// container's VOLUME lines.
func anonymousVolumes(t *testing.T, e *itest.Env, nameOrID string) []string {
	t.Helper()
	res, err := e.D.Client().ContainerInspect(e.Ctx(time.Minute), nameOrID, client.ContainerInspectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, m := range res.Container.Mounts {
		if m.Type == mount.TypeVolume && m.Destination == "/data" {
			names = append(names, m.Name)
		}
	}
	if len(names) == 0 {
		t.Fatalf("%s has no anonymous volume for /data: %+v", nameOrID, res.Container.Mounts)
	}
	return names
}

func expectVolumesGone(t *testing.T, e *itest.Env, names []string) {
	t.Helper()
	for _, name := range names {
		if _, err := e.D.Client().VolumeInspect(e.Ctx(time.Minute), name, client.VolumeInspectOptions{}); !jobrun.IsNotFound(err) {
			_, _ = e.D.Client().VolumeRemove(context.Background(), name, client.VolumeRemoveOptions{Force: true})
			t.Fatalf("anonymous volume %s left behind (err %v)", name, err)
		}
	}
}

// A one-off run (backup and restore helpers, cron runs) leaves no volume
// behind, even when its image declares one.
func TestRunRemovesAnonymousVolumes(t *testing.T) {
	e := itest.New(t)
	ctx := e.Ctx(5 * time.Minute)
	s := spec(e, e.Project+"-vol", "sleep 3; echo done")
	s.Image = volumeImage(t, e)
	done := make(chan error, 1)
	var out bytes.Buffer
	go func() {
		_, err := e.D.Run(ctx, s, jobrun.IO{Stdout: &out})
		done <- err
	}()
	e.Eventually("run container created", 30*time.Second, func() bool {
		_, found, _ := e.D.Inspect(ctx, s.Name)
		return found
	})
	names := anonymousVolumes(t, e, s.Name)
	if err := <-done; err != nil || strings.TrimSpace(out.String()) != "done" {
		t.Fatalf("run: %v, output %q", err, out.String())
	}
	expectVolumesGone(t, e, names)
}

// Helpers (database UIs, tunnels) and stopped containers removed by the
// cleanup inventory take their anonymous volumes with them too.
func TestRemoveAndRemoveContainerRemoveAnonymousVolumes(t *testing.T) {
	e := itest.New(t)
	ctx := e.Ctx(5 * time.Minute)
	image := volumeImage(t, e)

	helper := spec(e, e.Project+"-helper-vol", "sleep 600")
	helper.Image = image
	c, err := e.D.EnsureRunning(ctx, helper)
	if err != nil {
		t.Fatal(err)
	}
	names := anonymousVolumes(t, e, c.ID)
	if err := e.D.Remove(ctx, c.ID); err != nil {
		t.Fatal(err)
	}
	expectVolumesGone(t, e, names)

	stopped := spec(e, e.Project+"-stopped-vol", "true")
	stopped.Image = image
	c, err = e.D.EnsureRunning(ctx, stopped)
	if err != nil {
		t.Fatal(err)
	}
	names = anonymousVolumes(t, e, c.ID)
	e.Eventually("container stopped", 30*time.Second, func() bool {
		cur, found, _ := e.D.Inspect(ctx, c.ID)
		return found && !cur.Running
	})
	if err := e.D.RemoveContainer(ctx, c.ID); err != nil {
		t.Fatal(err)
	}
	expectVolumesGone(t, e, names)
}
