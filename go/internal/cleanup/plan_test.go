package cleanup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
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

// fakeDocker records removals; refuse makes RemoveUnlabeledImage fail
// for an id, as Docker's last check would.
type fakeDocker struct {
	snap    Snapshot
	removed []string
	refuse  map[string]error
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
func (f *fakeDocker) UnlabeledImages(context.Context) ([]jobrun.Image, error) {
	return f.snap.Unlabeled, nil
}
func (f *fakeDocker) ImageIDsInUse(context.Context) (map[string]bool, error) {
	return f.snap.InUse, nil
}
func (f *fakeDocker) RemoveUnlabeledImage(_ context.Context, id string) error {
	if err := f.refuse[id]; err != nil {
		return err
	}
	f.removed = append(f.removed, "pulled:"+id)
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

// Images without the seylo label follow the image rule once a service
// used them (UsedImages): any container on the machine keeps one, as do
// the desired one and the newest 3 a service used; an image goes only
// when every service it belongs to lets it go, and images no service
// used are never candidates.
func TestPlanPulledImages(t *testing.T) {
	day := func(d int) time.Time { return time.Date(2026, 1, d, 0, 0, 0, 0, time.UTC) }
	pulled := func(id string, tags ...string) jobrun.Image {
		return jobrun.Image{ID: id, RepoTags: tags, Labels: map[string]string{}, Created: day(1), Size: 100}
	}
	desired := desiredState()
	desired.Services = append(desired.Services,
		&agentv1.ServiceSpec{Id: "db", ProjectId: "p1", Generation: 2, Image: &agentv1.ImageRef{Reference: "postgres:16.3"}},
		// Pulled for a deploy that has not made its container yet: only a
		// removed service's record names these images.
		&agentv1.ServiceSpec{Id: "db2", ProjectId: "p1", Generation: 1, Image: &agentv1.ImageRef{Reference: "postgres:17"}},
		&agentv1.ServiceSpec{Id: "db3", ProjectId: "p1", Generation: 1, Image: &agentv1.ImageRef{Reference: "mysql:8", Digest: "sha256:m8"}},
	)
	s := Snapshot{Desired: desired,
		Unlabeled: []jobrun.Image{
			pulled("pg-16.0", "postgres:16.0"),
			pulled("pg-16.1", "postgres:16.1"),
			pulled("pg-16.2", "postgres:16.2"),
			pulled("pg-16.3", "postgres:16.3"), // desired
			pulled("pg-15", "postgres:15"),     // another program's container uses it
			pulled("redis", "redis:7"),         // the removed service's
			pulled("shared", "nginx:1"),        // removed service's, and db's newest
			pulled("never-used", "busybox:1"),  // no service used it
			pulled("pg-17", "postgres:17"),     // db2's desired, recorded for gone only
			{ID: "mysql-8", RepoDigests: []string{"mysql@sha256:m8"}, Labels: map[string]string{}, Created: day(1)},
			pulled("ui-1", "sosedoff/pgweb:1"), // db's web UI helper: ranks on its own
			pulled("ui-2", "sosedoff/pgweb:2"),
			pulled("ui-3", "sosedoff/pgweb:3"),
			pulled("ui-4", "sosedoff/pgweb:4"),
			{ID: "labeled", RepoTags: []string{"x:1"}, Labels: labels(), Created: day(1)},
		},
		InUse: map[string]bool{"pg-15": true},
		UsedBy: map[string]map[string]time.Time{
			"pg-16.0": {"db": day(2)},
			"pg-16.1": {"db": day(3)},
			"pg-16.2": {"db": day(4)},
			"pg-16.3": {"db": day(5)},
			"pg-15":   {"db": day(1)},
			"redis":   {"gone": day(9)},
			"shared":  {"gone": day(9), "db": day(6)},
			"labeled": {"gone": day(9)},
			"pg-17":   {"gone": day(1)},
			"mysql-8": {"gone": day(1)},
			"ui-1":    {"db/db-ui": day(7)},
			"ui-2":    {"db/db-ui": day(8)},
			"ui-3":    {"db/db-ui": day(9)},
			"ui-4":    {"db/db-ui": day(10)},
		},
	}
	items, _ := Plan(&agentv1.PruneRequest{Images: true}, s)
	got := map[string]string{}
	for _, it := range items {
		if !it.Unlabeled || it.Kind != KindImage {
			t.Fatalf("item %+v is not an unlabeled image", it)
		}
		got[it.ID] = it.Reason
	}
	// db's newest 3 are shared (which gone would let go), 16.3 (also
	// desired) and 16.2, whatever its web UI used; pg-15 is in use;
	// redis's service is gone; pg-17 and mysql-8 are desired (by tag and
	// by digest); the web UI keeps its own newest 3.
	want := map[string]string{
		"pg-16.0": "older than the newest 3",
		"pg-16.1": "older than the newest 3",
		"redis":   "service removed from this node",
		"ui-1":    "older than the newest 3",
	}
	if len(got) != len(want) {
		t.Fatalf("removed %v, want %v", got, want)
	}
	for id, reason := range want {
		if got[id] != reason {
			t.Fatalf("removed %v, want %v", got, want)
		}
	}

	// A node that never received a desired state removes nothing.
	s.Desired = &agentv1.DesiredState{}
	if items, _ := Plan(&agentv1.PruneRequest{Images: true}, s); len(items) != 0 {
		t.Fatalf("revision 0 removes %v", items)
	}
}

// The panel's own image is Seylo's even when no record says so (pulled
// before the record existed): the panel service keeps the newest 3.
func TestPlanOldPanelImages(t *testing.T) {
	day := func(d int) time.Time { return time.Date(2026, 1, d, 0, 0, 0, 0, time.UTC) }
	panel := func(id, version string, d int) jobrun.Image {
		return jobrun.Image{ID: id, RepoTags: []string{brand.Image + ":" + version}, Created: day(d), Size: 300}
	}
	desired := desiredState()
	desired.Services = append(desired.Services, &agentv1.ServiceSpec{Id: docker.PanelServiceID, Protected: true,
		Image: &agentv1.ImageRef{Reference: brand.Image + ":0.2.18"}})
	s := Snapshot{Desired: desired, Unlabeled: []jobrun.Image{
		panel("p13", "0.2.13", 13),
		panel("p14", "0.2.14", 14),
		panel("p15", "0.2.15", 15),
		panel("p16", "0.2.16", 16),
		panel("p17", "0.2.17", 17),
		panel("p18", "0.2.18", 18),
		{ID: "lookalike", RepoTags: []string{brand.Image + "-fork:0.1"}, Created: day(1)},
		{ID: "by-digest", RepoDigests: []string{brand.Image + "@sha256:abc"}, Created: day(2)},
	}}
	items, _ := Plan(&agentv1.PruneRequest{Images: true}, s)
	if got, want := names(items, KindImage), []string{"by-digest", "ghcr.io/seylo-dev/seylo:0.2.13 (p13)", "ghcr.io/seylo-dev/seylo:0.2.14 (p14)", "ghcr.io/seylo-dev/seylo:0.2.15 (p15)"}; !slices.Equal(got, want) {
		t.Fatalf("panel images removed = %v, want %v", got, want)
	}
}

func TestRepository(t *testing.T) {
	for ref, want := range map[string]string{
		"ghcr.io/seylo-dev/seylo:0.2.18":          "ghcr.io/seylo-dev/seylo",
		"ghcr.io/seylo-dev/seylo@sha256:abc":      "ghcr.io/seylo-dev/seylo",
		"127.0.0.1:5755/svc:3":                    "127.0.0.1:5755/svc",
		"127.0.0.1:5755/svc":                      "127.0.0.1:5755/svc",
		"postgres":                                "postgres",
		"ghcr.io/seylo-dev/seylo:0.2.18@sha256:a": "ghcr.io/seylo-dev/seylo",
	} {
		if got := repository(ref); got != want {
			t.Errorf("repository(%q) = %q, want %q", ref, got, want)
		}
	}
}

type fakeRegistry struct {
	calls []bool
	err   error
}

func (f *fakeRegistry) PruneRegistry(_ context.Context, dryRun bool) (uint64, []string, error) {
	f.calls = append(f.calls, dryRun)
	if f.err != nil {
		return 0, nil, f.err
	}
	return 7000, []string{"registry: 6.8 KiB freed"}, nil
}

// A cleanup with images runs the registry's garbage collection and counts
// what it freed; pulled images go through RemoveUnlabeledImage; the
// record learns from the containers it sees.
func TestLocalPrunesPulledImagesAndTheRegistry(t *testing.T) {
	now := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	fd := &fakeDocker{snap: Snapshot{
		Containers: []jobrun.Container{{ID: "c1", ImageID: "live-now", Running: true, Labels: labels(docker.LabelService, "live", docker.LabelGeneration, "4")}},
		Unlabeled: []jobrun.Image{
			{ID: "live-now", RepoTags: []string{"app:2"}, Created: now, Size: 10},
			{ID: "gone-img", RepoTags: []string{"redis:7"}, Created: now, Size: 20},
			{ID: "stale", RepoTags: []string{"old:1"}, Created: now, Size: 5},
		},
		InUse: map[string]bool{"live-now": true},
	}}
	used := NewUsedImages(filepath.Join(t.TempDir(), "used.json"), nil)
	used.Record(now.Add(-time.Hour), Use{Service: "gone", Image: "gone-img"}, Use{Service: "gone", Image: "deleted-meanwhile"})
	reg := &fakeRegistry{}
	p := NewLocal(Options{Docker: fd, Layout: datadir.New(t.TempDir()), Desired: desiredState, Registry: reg, UsedImages: used, Now: func() time.Time { return now }})

	resp, err := p.Prune(context.Background(), &agentv1.PruneRequest{Images: true})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(fd.removed, []string{"pulled:gone-img"}) || resp.GetReclaimedBytes() != 7020 || !slices.Equal(reg.calls, []bool{false}) {
		t.Fatalf("removed %v, reclaimed %d, registry calls %v", fd.removed, resp.GetReclaimedBytes(), reg.calls)
	}
	if !slices.Contains(resp.GetRemoved(), "registry: 6.8 KiB freed") {
		t.Fatalf("lines %v", resp.GetRemoved())
	}
	rec := used.Snapshot()
	if rec["live-now"]["live"] != now || rec["deleted-meanwhile"] != nil {
		t.Fatalf("record = %v", rec)
	}

	// A removal the last check refuses is reported as kept, not as a failure.
	fd.snap.Containers = nil
	fd.snap.InUse = nil
	fd.refuse = map[string]error{"stale-2": jobrun.ErrImageShared}
	fd.snap.Unlabeled = append(fd.snap.Unlabeled, jobrun.Image{ID: "stale-2", RepoTags: []string{"redis:6"}, Created: now})
	used.Record(now, Use{Service: "gone", Image: "stale-2"})
	resp, err = p.Prune(context.Background(), &agentv1.PruneRequest{Images: true})
	if err != nil || !slices.ContainsFunc(resp.GetRemoved(), func(l string) bool { return strings.HasPrefix(l, "kept image redis:6") }) {
		t.Fatalf("refused removal: %v %v", err, resp.GetRemoved())
	}

	// Without the images kind the registry is left alone; its failure is a note.
	reg.err = errors.New("docker: boom")
	if _, err := p.Prune(context.Background(), &agentv1.PruneRequest{StoppedContainers: true}); err != nil || len(reg.calls) != 2 {
		t.Fatalf("registry called for containers only: %v %v", err, reg.calls)
	}
	resp, err = p.Prune(context.Background(), &agentv1.PruneRequest{Images: true, DryRun: true})
	if err != nil || !slices.Contains(resp.GetRemoved(), "registry: docker: boom") || !slices.Equal(reg.calls, []bool{false, false, true}) {
		t.Fatalf("dry run: %v %v %v", err, resp.GetRemoved(), reg.calls)
	}
}

// A service's own containers and its cron and backup runs count under
// its id, helpers with their own image under "<service>/<role>"; a stopped
// container of an older generation counts as no use.
func TestImageUses(t *testing.T) {
	got := imageUses([]jobrun.Container{
		{ImageID: "app", Running: true, Labels: labels(docker.LabelService, "live", docker.LabelGeneration, "4")},
		{ImageID: "ui", Labels: labels(docker.LabelService, "live", docker.LabelRole, jobrun.RoleDBUI)},
		{ImageID: "app", Labels: labels(docker.LabelService, "live", docker.LabelRole, jobrun.RoleCron)},
		{ImageID: "pg", Labels: labels(docker.LabelService, "live", docker.LabelRole, jobrun.RoleBackup)},
		{ImageID: "old", Labels: labels(docker.LabelService, "live", docker.LabelGeneration, "2")},
		{ImageID: "old-running", Running: true, Labels: labels(docker.LabelService, "live", docker.LabelGeneration, "3")},
		{ImageID: "traefik", Labels: labels()},
		{ImageID: "", Labels: labels(docker.LabelService, "live")},
	}, desiredState())
	want := []Use{{Service: "live", Image: "app"}, {Service: "live/db-ui", Image: "ui"}, {Service: "live", Image: "app"},
		{Service: "live", Image: "pg"}, {Service: "live", Image: "old-running"}}
	if !slices.Equal(got, want) {
		t.Fatalf("uses = %v, want %v", got, want)
	}
}

// An image whose names span repositories (someone else tagged it) is kept
// by the plan too, so a preview does not count what every run keeps.
func TestPlanKeepsImagesNamedInTwoRepositories(t *testing.T) {
	s := Snapshot{Desired: desiredState(),
		Unlabeled: []jobrun.Image{
			{ID: "two-tags", RepoTags: []string{"nginx:1", "myorg/proxy:1"}, Size: 10},
			{ID: "tag-and-digest", RepoTags: []string{"nginx:2"}, RepoDigests: []string{"mirror.gcr.io/library/nginx@sha256:a"}, Size: 10},
			{ID: "same-repo", RepoTags: []string{"nginx:3", "nginx:3.1"}, RepoDigests: []string{"nginx@sha256:b", "<none>@<none>"}, Size: 10},
		},
		UsedBy: map[string]map[string]time.Time{
			"two-tags": {"gone": {}}, "tag-and-digest": {"gone": {}}, "same-repo": {"gone": {}},
		},
	}
	items, _ := Plan(&agentv1.PruneRequest{Images: true}, s)
	if len(items) != 1 || items[0].ID != "same-repo" {
		t.Fatalf("items = %v", items)
	}
}
