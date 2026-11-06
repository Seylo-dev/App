package cleanup

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

func labels(kv ...string) map[string]string {
	m := map[string]string{docker.LabelManaged: "true"}
	for i := 0; i < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return m
}

func desiredState() *agentv1.DesiredState {
	return &agentv1.DesiredState{
		Revision: 5,
		Services: []*agentv1.ServiceSpec{
			{Id: "live", ProjectId: "p1", Generation: 4, Image: &agentv1.ImageRef{Reference: "127.0.0.1:5755/live:4", Digest: "sha256:d4"}},
			{Id: "member", ProjectId: "p1", Generation: 1, Volumes: []*agentv1.VolumeMount{{Name: "shared", OwnerServiceId: "stackowner"}}},
		},
		Networks: []*agentv1.ProjectNetwork{{ProjectId: "p1"}},
	}
}

func names(items []Item, kind ItemKind) []string {
	var out []string
	for _, it := range items {
		if it.Kind == kind {
			out = append(out, it.Name)
		}
	}
	slices.Sort(out)
	return out
}

var all = &agentv1.PruneRequest{Images: true, StoppedContainers: true, OrphanedServiceData: true}

func TestPlanContainers(t *testing.T) {
	s := Snapshot{Desired: desiredState(), Containers: []jobrun.Container{
		{ID: "1", Name: "unlabeled-stopped", Labels: map[string]string{docker.LabelService: "gone"}},
		{ID: "2", Name: "old-gen", Labels: labels(docker.LabelService, "live", docker.LabelGeneration, "3")},
		{ID: "3", Name: "current-gen-crashed", Labels: labels(docker.LabelService, "live", docker.LabelGeneration, "4")},
		{ID: "4", Name: "running-old-gen", Running: true, Labels: labels(docker.LabelService, "live", docker.LabelGeneration, "2")},
		{ID: "5", Name: "removed-service", Labels: labels(docker.LabelService, "gone", docker.LabelGeneration, "1")},
		{ID: "6", Name: "cron-leftover", Labels: labels(docker.LabelService, "live", docker.LabelRole, jobrun.RoleCron)},
		{ID: "7", Name: "sleeping-db-ui", Labels: labels(docker.LabelService, "live", docker.LabelRole, jobrun.RoleDBUI)},
		{ID: "8", Name: "traefik", Labels: labels(docker.LabelRole, "traefik")},
		{ID: "9", Name: "protected-old", Labels: labels(docker.LabelService, "panel", docker.LabelProtected, "true", docker.LabelGeneration, "1")},
	}, Networks: []jobrun.Network{
		{ID: "n1", Name: "seylo-p-p1", Labels: labels()},
		{ID: "n2", Name: "seylo-p-gone", Labels: labels()},
		{ID: "n3", Name: "seylo-edge", Labels: labels()},
		{ID: "n4", Name: "seylo-p-prot", Labels: labels(docker.LabelProtected, "true")},
	}}
	items, notes := Plan(all, s)
	if got, want := names(items, KindContainer), []string{"cron-leftover", "old-gen", "removed-service"}; !slices.Equal(got, want) {
		t.Fatalf("containers = %v, want %v", got, want)
	}
	if got := names(items, KindNetwork); !slices.Equal(got, []string{"seylo-p-gone"}) {
		t.Fatalf("networks = %v", got)
	}
	if len(notes) != 0 {
		t.Fatalf("notes = %v", notes)
	}
}

func TestPlanImagesKeepsInUseDesiredAndNewest(t *testing.T) {
	day := func(d int) time.Time { return time.Date(2026, 1, d, 0, 0, 0, 0, time.UTC) }
	img := func(id, svc string, d int, extra ...string) jobrun.Image {
		return jobrun.Image{ID: id, Labels: labels(append([]string{docker.LabelService, svc}, extra...)...), Created: day(d), Size: 100, RepoTags: []string{id + ":tag"}}
	}
	s := Snapshot{Desired: desiredState(),
		Containers: []jobrun.Container{{ID: "c", ImageID: "used-old", Labels: labels(docker.LabelService, "live")}},
		Images: []jobrun.Image{
			img("used-old", "live", 1),
			img("v2", "live", 2),
			img("v3", "live", 3),
			img("v5", "live", 5),
			img("v6", "live", 6),
			img("v7", "live", 7),
			{ID: "desired", Labels: labels(docker.LabelService, "live"), Created: day(1), RepoDigests: []string{"127.0.0.1:5755/live@sha256:d4"}},
			img("gone-1", "gone", 9),
			img("gone-2", "gone", 8),
			{ID: "unlabeled", Labels: map[string]string{docker.LabelService: "gone"}, Created: day(1)},
			{ID: "infra", Labels: labels(), Created: day(1)},
			img("prot", "gone", 1, docker.LabelProtected, "true"),
		}}
	items, _ := Plan(&agentv1.PruneRequest{Images: true}, s)
	var ids []string
	for _, it := range items {
		ids = append(ids, it.ID)
	}
	slices.Sort(ids)
	// live keeps used-old, desired and the 3 newest (v7, v6, v5).
	if want := []string{"gone-1", "gone-2", "v2", "v3"}; !slices.Equal(ids, want) {
		t.Fatalf("images = %v, want %v", ids, want)
	}
}

func TestPlanOrphanedData(t *testing.T) {
	s := Snapshot{Desired: desiredState(),
		Containers: []jobrun.Container{{ID: "c", Labels: labels(docker.LabelService, "stopping")}},
		Volumes: []jobrun.Volume{
			{Name: "v-live", Labels: labels(docker.LabelService, "live")},
			{Name: "v-gone", Labels: labels(docker.LabelService, "gone")},
			{Name: "v-unlabeled", Labels: map[string]string{docker.LabelService: "gone"}},
			{Name: "v-stackowner", Labels: labels(docker.LabelService, "stackowner")},
			{Name: "v-stopping", Labels: labels(docker.LabelService, "stopping")},
		},
		ServiceDirs: []ServiceDir{
			{ServiceID: "live", Path: "/d/services/live"},
			{ServiceID: "gone", Path: "/d/services/gone", Size: 2048},
			{ServiceID: "stackowner", Path: "/d/services/stackowner"},
			{ServiceID: "stopping", Path: "/d/services/stopping"},
		}}
	items, _ := Plan(&agentv1.PruneRequest{OrphanedServiceData: true}, s)
	if got := names(items, KindVolume); !slices.Equal(got, []string{"v-gone"}) {
		t.Fatalf("volumes = %v", got)
	}
	if got := names(items, KindData); !slices.Equal(got, []string{"gone"}) {
		t.Fatalf("data = %v", got)
	}
	if !strings.Contains(items[len(items)-1].Describe(), "2.0 KiB") {
		t.Fatalf("describe = %q", items[len(items)-1].Describe())
	}
}

func TestPlanWithoutDesiredStateOnlyRemovesJobLeftovers(t *testing.T) {
	s := Snapshot{Desired: &agentv1.DesiredState{},
		Containers: []jobrun.Container{
			{ID: "1", Name: "cron", Labels: labels(docker.LabelService, "a", docker.LabelRole, jobrun.RoleBackup)},
			{ID: "2", Name: "app", Labels: labels(docker.LabelService, "a", docker.LabelGeneration, "1")},
		},
		Images:      []jobrun.Image{{ID: "i", Labels: labels(docker.LabelService, "a")}},
		Volumes:     []jobrun.Volume{{Name: "v", Labels: labels(docker.LabelService, "a")}},
		Networks:    []jobrun.Network{{ID: "n", Name: "seylo-p-x", Labels: labels()}},
		ServiceDirs: []ServiceDir{{ServiceID: "a", Path: "/d/services/a"}},
	}
	items, notes := Plan(all, s)
	if len(items) != 1 || items[0].Name != "cron" || len(notes) != 1 {
		t.Fatalf("items = %v, notes = %v", items, notes)
	}
}

// fakeDocker records removals.
type fakeDocker struct {
	snap    Snapshot
	removed []string
}

func (f *fakeDocker) ContainersWithSize(context.Context) ([]jobrun.Container, error) {
	return f.snap.Containers, nil
}
func (f *fakeDocker) Images(context.Context) ([]jobrun.Image, error)     { return f.snap.Images, nil }
func (f *fakeDocker) Volumes(context.Context) ([]jobrun.Volume, error)   { return f.snap.Volumes, nil }
func (f *fakeDocker) Networks(context.Context) ([]jobrun.Network, error) { return f.snap.Networks, nil }
func (f *fakeDocker) RemoveContainer(_ context.Context, id string) error {
	f.removed = append(f.removed, "container:"+id)
	return nil
}
func (f *fakeDocker) RemoveImage(_ context.Context, id string) error {
	f.removed = append(f.removed, "image:"+id)
	return nil
}
func (f *fakeDocker) RemoveVolume(_ context.Context, n string) error {
	f.removed = append(f.removed, "volume:"+n)
	return nil
}
func (f *fakeDocker) RemoveNetwork(_ context.Context, id string) error {
	f.removed = append(f.removed, "network:"+id)
	return nil
}

func TestLocalDryRunThenRun(t *testing.T) {
	layout := datadir.New(t.TempDir())
	gone, _ := layout.ServiceDir("gone")
	live, _ := layout.ServiceDir("live")
	for _, d := range []string{gone, live} {
		if err := os.MkdirAll(filepath.Join(d, "volumes", "data"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "volumes", "data", "f"), make([]byte, 5000), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	fd := &fakeDocker{snap: Snapshot{Containers: []jobrun.Container{
		{ID: "c1", Name: "old", SizeRw: 10, Labels: labels(docker.LabelService, "live", docker.LabelGeneration, "1")},
	}}}
	p := NewLocal(Options{Docker: fd, Layout: layout, Desired: desiredState})
	req := &agentv1.PruneRequest{StoppedContainers: true, OrphanedServiceData: true, BuildCache: true, DryRun: true}
	resp, err := p.Prune(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.GetReclaimedBytes() != 5010 || len(fd.removed) != 0 {
		t.Fatalf("dry run = %v, removed %v", resp, fd.removed)
	}
	if !slices.ContainsFunc(resp.GetRemoved(), func(s string) bool { return strings.Contains(s, "build cache: not supported") }) {
		t.Fatalf("dry run lines = %v", resp.GetRemoved())
	}
	if _, err := os.Stat(gone); err != nil {
		t.Fatal("dry run deleted data")
	}
	req.DryRun = false
	resp, err = p.Prune(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(fd.removed, []string{"container:c1"}) || resp.GetReclaimedBytes() != 5010 {
		t.Fatalf("run = %v, removed %v", resp, fd.removed)
	}
	if _, err := os.Stat(gone); !os.IsNotExist(err) {
		t.Fatal("orphaned data still there")
	}
	if _, err := os.Stat(live); err != nil {
		t.Fatal("live service data deleted")
	}
}

func TestPlanRemovesDataOnceItsLastContainerGoes(t *testing.T) {
	s := Snapshot{Desired: desiredState(),
		Containers:  []jobrun.Container{{ID: "c", Name: "leftover", Labels: labels(docker.LabelService, "gone", docker.LabelGeneration, "1")}},
		Volumes:     []jobrun.Volume{{Name: "v", Labels: labels(docker.LabelService, "gone")}},
		ServiceDirs: []ServiceDir{{ServiceID: "gone", Path: "/d/services/gone"}},
	}
	// Without container cleanup the leftover holds the data back.
	items, _ := Plan(&agentv1.PruneRequest{OrphanedServiceData: true}, s)
	if len(items) != 0 {
		t.Fatalf("items = %v", items)
	}
	items, _ = Plan(all, s)
	if got := []string{names(items, KindContainer)[0], names(items, KindVolume)[0], names(items, KindData)[0]}; !slices.Equal(got, []string{"leftover", "v", "gone"}) {
		t.Fatalf("items = %v", items)
	}
	if items[0].Kind != KindContainer {
		t.Fatal("containers must go first")
	}
}
