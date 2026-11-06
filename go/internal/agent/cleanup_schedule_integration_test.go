//go:build integration && linux

package agent

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/cleanup"
	"github.com/seylo-dev/app/go/internal/cron"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
	"github.com/seylo-dev/app/go/internal/state"
)

// scopedDocker narrows the cleanup inventory to one test project: the VM is
// shared with other tests, whose managed resources would look like orphans.
type scopedDocker struct {
	*jobrun.Docker
	project string
}

func (s scopedDocker) ContainersWithSize(ctx context.Context) ([]jobrun.Container, error) {
	all, err := s.Docker.ContainersWithSize(ctx)
	return slices.DeleteFunc(all, func(c jobrun.Container) bool { return c.Labels[docker.LabelProject] != s.project }), err
}

func (s scopedDocker) Images(ctx context.Context) ([]jobrun.Image, error) {
	all, err := s.Docker.Images(ctx)
	return slices.DeleteFunc(all, func(i jobrun.Image) bool { return i.Labels[docker.LabelProject] != s.project }), err
}

func (s scopedDocker) Networks(ctx context.Context) ([]jobrun.Network, error) {
	all, err := s.Docker.Networks(ctx)
	return slices.DeleteFunc(all, func(n jobrun.Network) bool { return !strings.Contains(n.Name, s.project) }), err
}

// A disk past the line (a small tmpfs filled to about 94%, read by the real
// disk check) starts a scheduled cleanup that removes a managed orphan and
// leaves its unlabeled look-alike alone, and reports the run durably.
func TestITCleanupOnTheDiskTrigger(t *testing.T) {
	e := itest.New(t)
	ctx := e.Ctx(5 * time.Minute)
	cli := e.D.Client()
	e.Pull("busybox:1.37")
	p := e.Project

	disk := t.TempDir()
	if out, err := exec.Command("mount", "-t", "tmpfs", "-o", "size=8m", "nodeops-tmpfs", disk).CombinedOutput(); err != nil {
		t.Fatalf("mount tmpfs: %v %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("umount", disk).Run() })
	if err := os.WriteFile(filepath.Join(disk, "fill"), make([]byte, 7680<<10), 0o644); err != nil {
		t.Fatal(err)
	}

	labels := func(managed bool) map[string]string {
		m := map[string]string{docker.LabelProject: p, docker.LabelService: p + "gone", docker.LabelRole: jobrun.RoleCron}
		if managed {
			m[docker.LabelManaged] = "true"
		}
		return m
	}
	mk := func(name string, managed bool) string {
		res, err := cli.ContainerCreate(ctx, client.ContainerCreateOptions{Name: name, Config: &container.Config{Image: "busybox:1.37", Cmd: []string{"true"}, Labels: labels(managed)}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = cli.ContainerRemove(context.Background(), res.ID, client.ContainerRemoveOptions{Force: true})
		})
		return res.ID
	}
	ours := mk("nodeops-"+p+"-ours", true)
	theirs := mk("nodeops-"+p+"-theirs", false)

	desired := &agentv1.DesiredState{Revision: 2, Networks: []*agentv1.ProjectNetwork{{ProjectId: p}}}
	pruner := cleanup.NewLocal(cleanup.Options{Docker: scopedDocker{e.D, p}, Layout: e.Layout, Desired: func() *agentv1.DesiredState { return desired }})
	rec := rpctest.NewRecorder()
	sched := cleanup.NewScheduler(cleanup.SchedulerOptions{
		Pruner: pruner,
		Parse:  func(expr string) (cleanup.Schedule, error) { return cron.ParseScheduleIn(expr, time.Local) },
		Report: func(ctx context.Context, run *agentv1.CleanupRun) error {
			return rec.Event(ctx, &agentv1.Event{Payload: &agentv1.Event_CleanupRun{CleanupRun: run}})
		},
	})
	if err := sched.Sync(2, &agentv1.CleanupSchedule{Enabled: true, Cron: "0 4 * * *", DiskPercent: 80, StoppedContainers: true}); err != nil {
		t.Fatal(err)
	}
	go func() { _ = sched.Run(ctx) }()

	disks := &diskWatch{
		paths:   func(context.Context) []diskPath { return []diskPath{{"data dir", disk}} },
		stat:    fsUsage,
		reports: func() state.Reporter { return rec },
		logger:  slog.New(slog.DiscardHandler),
		onUse:   sched.DiskUse,
	}
	disks.check(ctx)

	ev := rec.WaitDurable(t, func(ev *agentv1.Event) bool { return ev.GetCleanupRun() != nil })
	run := ev.GetCleanupRun()
	t.Logf("run: %v", run)
	if run.GetTrigger() != agentv1.CleanupTrigger_CLEANUP_TRIGGER_DISK || run.GetDiskPercent() < 80 || run.GetError() != "" {
		t.Fatalf("run = %v", run)
	}
	mentions := func(s string) bool {
		return slices.ContainsFunc(run.GetRemoved(), func(l string) bool { return strings.Contains(l, s) })
	}
	if !mentions(p+"-ours") || mentions(p+"-theirs") {
		t.Fatalf("removed = %v", run.GetRemoved())
	}
	if _, err := cli.ContainerInspect(ctx, ours, client.ContainerInspectOptions{}); err == nil {
		t.Error("the managed orphan survived")
	}
	if _, err := cli.ContainerInspect(ctx, theirs, client.ContainerInspectOptions{}); err != nil {
		t.Error("the unlabeled look-alike was removed")
	}
	// The same check raised the disk alert (94% is past 85%).
	if a := diskAlerts(rec); len(a) != 1 || a[0].GetResolved() {
		t.Fatalf("disk alerts = %v", a)
	}
}
