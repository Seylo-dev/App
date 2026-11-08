package metrics

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/console/dockerapi"
	"github.com/seylo-dev/app/go/internal/docker"
)

func TestContainerMemory(t *testing.T) {
	tests := []struct {
		name string
		m    dockerapi.MemoryStats
		want uint64
	}{
		{"cgroup v2 subtracts inactive_file", dockerapi.MemoryStats{Usage: 500 << 20, Stats: map[string]uint64{"inactive_file": 300 << 20, "active_file": 50 << 20}}, 200 << 20},
		{"cgroup v1 subtracts total_inactive_file", dockerapi.MemoryStats{Usage: 500 << 20, Stats: map[string]uint64{"total_inactive_file": 100 << 20, "inactive_file": 1}}, 400 << 20},
		{"no stats keeps usage", dockerapi.MemoryStats{Usage: 42}, 42},
		{"inactive larger than usage keeps usage", dockerapi.MemoryStats{Usage: 10, Stats: map[string]uint64{"inactive_file": 20}}, 10},
	}
	for _, tt := range tests {
		if got := containerMemory(tt.m); got != tt.want {
			t.Errorf("%s: got %d, want %d", tt.name, got, tt.want)
		}
	}
}

func stats(container, system uint64, cpus uint32) *dockerapi.Stats {
	s := &dockerapi.Stats{}
	s.CPUStats.CPUUsage.TotalUsage = container
	s.CPUStats.SystemUsage = system
	s.CPUStats.OnlineCPUs = cpus
	return s
}

func TestContainerCPU(t *testing.T) {
	// A quarter of all system time on a 4-core host = one full core.
	if got := containerCPU(cpuSample{1000, 10000}, stats(2000, 14000, 4)); got != 100 {
		t.Fatalf("got %v, want 100", got)
	}
	if got := containerCPU(cpuSample{}, stats(2000, 14000, 4)); got != 0 {
		t.Fatalf("first sample = %v", got)
	}
	if got := containerCPU(cpuSample{5000, 10000}, stats(10, 20000, 4)); got != 0 {
		t.Fatalf("restarted container counters = %v", got)
	}
}

func TestCPUPercentNode(t *testing.T) {
	if got := cpuPercent(cpuTimes{total: 1000, idle: 800}, cpuTimes{total: 2000, idle: 1550}); got != 25 {
		t.Fatalf("got %v", got)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fakeHost(t *testing.T) *Host {
	root := t.TempDir()
	proc, sys := filepath.Join(root, "proc"), filepath.Join(root, "sys")
	writeFile(t, filepath.Join(proc, "stat"), "cpu  100 0 100 700 100 0 0 0 50 0\ncpu0 50 0 50 350 50 0 0 0 0 0\ncpu1 50 0 50 350 50 0 0 0 0 0\nintr 1\n")
	writeFile(t, filepath.Join(proc, "meminfo"), "MemTotal:       4000000 kB\nMemFree:         500000 kB\nMemAvailable:   3000000 kB\nSwapTotal:      1000 kB\nSwapFree:        250 kB\n")
	writeFile(t, filepath.Join(proc, "loadavg"), "0.50 0.25 0.10 1/200 12345\n")
	writeFile(t, filepath.Join(proc, "net", "dev"), `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0
  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0
veth12: 50000 10 0 0 0 0 0 0 60000 20 0 0 0 0 0 0
docker0: 7 1 0 0 0 0 0 0 8 1 0 0 0 0 0 0
`)
	writeFile(t, filepath.Join(sys, "class", "net", "eth0", "device", "x"), "")
	writeFile(t, filepath.Join(proc, "self", "mounts"), `/dev/vda1 / ext4 rw 0 0
/dev/vda1 /var/lib/docker ext4 rw 0 0
/dev/vdb /mnt/data\040disk xfs rw 0 0
overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0
tmpfs /run tmpfs rw 0 0
mac /Users virtiofs rw 0 0
`)
	return &Host{Proc: proc, Sys: sys, DataDir: "/var/lib/seylo", Statfs: func(path string) (uint64, uint64, error) {
		switch path {
		case "/", "/var/lib/docker":
			return 10, 100, nil
		case "/mnt/data disk":
			return 5, 50, nil
		case "/var/lib/seylo", "/var/lib":
			return 0, 0, errors.New("missing")
		case "/var":
			return 11, 100, nil
		}
		return 0, 0, errors.New("no fs")
	}}
}

func TestHostSample(t *testing.T) {
	h := fakeHost(t)
	u, err := h.Sample()
	if err != nil {
		t.Fatal(err)
	}
	if u.GetCpuCount() != 2 || u.GetCpuPercent() != 0 {
		t.Fatalf("cpu = %d cores, %v%%", u.GetCpuCount(), u.GetCpuPercent())
	}
	if u.GetMemoryTotalBytes() != 4000000*1024 || u.GetMemoryUsedBytes() != 1000000*1024 {
		t.Fatalf("memory = %d / %d", u.GetMemoryUsedBytes(), u.GetMemoryTotalBytes())
	}
	if u.GetSwapUsedBytes() != 750*1024 || u.GetLoad5() != 0.25 {
		t.Fatalf("swap %d load5 %v", u.GetSwapUsedBytes(), u.GetLoad5())
	}
	if u.GetNetworkRxBytes() != 1000 || u.GetNetworkTxBytes() != 2000 {
		t.Fatalf("network = %d/%d (only eth0 is physical)", u.GetNetworkRxBytes(), u.GetNetworkTxBytes())
	}
	if len(u.GetDisks()) != 2 || u.GetDisks()[0].GetMountPoint() != "/" || u.GetDisks()[1].GetMountPoint() != "/mnt/data disk" {
		t.Fatalf("disks = %v", u.GetDisks())
	}
	if u.GetDiskUsedBytes() != 11 || u.GetDiskTotalBytes() != 100 {
		t.Fatalf("data dir disk = %d/%d", u.GetDiskUsedBytes(), u.GetDiskTotalBytes())
	}
	// Second sample: 50% busy since the first.
	writeFile(t, filepath.Join(h.Proc, "stat"), "cpu  200 0 200 750 150 0 0 0 0 0\ncpu0 0\ncpu1 0\n")
	u, _ = h.Sample()
	if p := u.GetCpuPercent(); p < 66.6 || p > 66.7 {
		t.Fatalf("cpu percent = %v", u.GetCpuPercent())
	}
}

type fakeSource struct {
	containers []dockerapi.Container
	stats      map[string]*dockerapi.Stats
}

func (f *fakeSource) ListContainers(context.Context, bool, map[string]string) ([]dockerapi.Container, error) {
	return f.containers, nil
}

func (f *fakeSource) StatsOnce(_ context.Context, id string) (*dockerapi.Stats, error) {
	if s, ok := f.stats[id]; ok {
		return s, nil
	}
	return nil, errors.New("gone")
}

func ctr(id, svc string) dockerapi.Container {
	return dockerapi.Container{ID: id, State: "running", Labels: map[string]string{docker.LabelService: svc}}
}

func TestSamplerSumsReplicas(t *testing.T) {
	mk := func(cpu, sys uint64, mem, limit uint64, rx uint64) *dockerapi.Stats {
		s := stats(cpu, sys, 2)
		s.MemoryStats = dockerapi.MemoryStats{Usage: mem, Limit: limit, Stats: map[string]uint64{"inactive_file": 10}}
		s.Networks = map[string]struct {
			RxBytes uint64 `json:"rx_bytes"`
			TxBytes uint64 `json:"tx_bytes"`
		}{"eth0": {RxBytes: rx, TxBytes: 1}}
		return s
	}
	src := &fakeSource{
		containers: []dockerapi.Container{ctr("a1", "app"), ctr("a2", "app"), ctr("d1", "db"), {ID: "x", State: "running"}},
		stats:      map[string]*dockerapi.Stats{"a1": mk(0, 1000, 110, 1000, 5), "a2": mk(0, 1000, 210, 1000, 7), "d1": mk(0, 1000, 60, 8000, 1)},
	}
	s := newSampler(src, nil)
	if _, err := s.services(context.Background(), nil, 8000); err != nil {
		t.Fatal(err)
	}
	src.stats["a1"] = mk(100, 2000, 110, 1000, 5) // 10% of 2 cores = 20
	src.stats["a2"] = mk(50, 2000, 210, 1000, 7)  // 10
	got, err := s.services(context.Background(), nil, 8000)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].GetServiceId() != "app" || got[1].GetServiceId() != "db" {
		t.Fatalf("services = %v", got)
	}
	app := got[0]
	if app.GetInstances() != 2 || app.GetCpuPercent() != 30 || app.GetMemoryUsedBytes() != 300 || app.GetMemoryLimitBytes() != 2000 || app.GetNetworkRxBytes() != 12 {
		t.Fatalf("app = %v", app)
	}
	if got[1].GetMemoryLimitBytes() != 0 {
		t.Fatalf("db without a limit reports %d", got[1].GetMemoryLimitBytes())
	}
	only, _ := s.services(context.Background(), []string{"db"}, 8000)
	if len(only) != 1 || only[0].GetServiceId() != "db" {
		t.Fatalf("filtered = %v", only)
	}
}

// TestKeepsOnlyTheLatestSample: an hour of full reports (node plus every
// service, every 10s) was about 11 MiB per 200 services on every node,
// for GetMetrics, which nothing calls; the panel keeps its own window.
func TestKeepsOnlyTheLatestSample(t *testing.T) {
	c := NewDockerCollector(&fakeSource{}, "", 0)
	if got := c.History(time.Time{}, nil); len(got) != 0 {
		t.Fatalf("before any sample = %v", got)
	}
	base := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	for i := range 400 { // 400 x 10s = 66 minutes
		c.record(&agentv1.MetricsReport{
			Time:     timestamppb.New(base.Add(time.Duration(i) * 10 * time.Second)),
			Node:     &agentv1.NodeUsage{CpuPercent: float64(i)},
			Services: []*agentv1.ServiceUsage{{ServiceId: "a"}, {ServiceId: "b"}},
		})
	}
	all := c.History(time.Time{}, nil)
	if len(all) != 1 || all[0].GetNode().GetCpuPercent() != 399 {
		t.Fatalf("kept %d samples, want the latest only", len(all))
	}
	if len(all[0].GetServices()) != 0 {
		t.Fatal("node-only history carries services")
	}
	recent := c.History(base.Add(3980*time.Second), []string{"b"})
	if len(recent) != 1 || len(recent[0].GetServices()) != 1 || recent[0].GetServices()[0].GetServiceId() != "b" {
		t.Fatalf("recent = %v", recent)
	}
	if got := c.History(base.Add(3990*time.Second), nil); len(got) != 0 {
		t.Fatalf("since the latest sample = %v", got)
	}
}
