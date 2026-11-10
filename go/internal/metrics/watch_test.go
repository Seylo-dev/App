package metrics

// The dashboard's live graphs: light watches (CPU, memory and network from
// three /proc files) that end by themselves when their lease runs out.
// The watch tests run in a synctest bubble, so a minute of a lease takes
// no real time.

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/console/dockerapi"
)

// countingSource is a Docker that counts every call: a light watch makes none.
type countingSource struct {
	fakeSource
	calls atomic.Int64
}

func (c *countingSource) ListContainers(ctx context.Context, all bool, labels map[string]string) ([]dockerapi.Container, error) {
	c.calls.Add(1)
	return c.fakeSource.ListContainers(ctx, all, labels)
}

func (c *countingSource) StatsOnce(ctx context.Context, id string) (*dockerapi.Stats, error) {
	c.calls.Add(1)
	return c.fakeSource.StatsOnce(ctx, id)
}

// hostFixture writes the /proc and /sys files once and returns a factory
// for fresh Hosts over them (each watch gets its own) and a count of the
// statfs calls they made.
func hostFixture(t *testing.T) (func() *Host, *atomic.Int64) {
	t.Helper()
	fixture := fakeHost(t)
	var statfs atomic.Int64
	return func() *Host {
		return &Host{Proc: fixture.Proc, Sys: fixture.Sys, DataDir: fixture.DataDir, Statfs: func(path string) (uint64, uint64, error) {
			statfs.Add(1)
			return fixture.Statfs(path)
		}}
	}, &statfs
}

// collectorOver is a DockerCollector reading the fixture, with Docker counted.
func collectorOver(t *testing.T) (*DockerCollector, *countingSource, *atomic.Int64) {
	t.Helper()
	src := &countingSource{fakeSource: fakeSource{containers: []dockerapi.Container{ctr("a1", "app")}}}
	c := NewDockerCollector(src, "", 0)
	newHost, statfs := hostFixture(t)
	c.newHost = newHost
	return c, src, statfs
}

func TestHostSampleLight(t *testing.T) {
	newHost, statfs := hostFixture(t)
	h := newHost()
	u, err := h.SampleLight()
	if err != nil {
		t.Fatal(err)
	}
	if u.GetCpuCount() != 2 || u.GetMemoryTotalBytes() != 4000000*1024 || u.GetMemoryUsedBytes() != 1000000*1024 {
		t.Fatalf("cpu %d cores, memory %d / %d", u.GetCpuCount(), u.GetMemoryUsedBytes(), u.GetMemoryTotalBytes())
	}
	if u.GetNetworkRxBytes() != 1000 || u.GetNetworkTxBytes() != 2000 {
		t.Fatalf("network = %d/%d (only eth0 is physical)", u.GetNetworkRxBytes(), u.GetNetworkTxBytes())
	}
	// Nothing of the mount table, statfs or loadavg.
	if len(u.GetDisks()) != 0 || u.GetDiskTotalBytes() != 0 || u.GetLoad1() != 0 || statfs.Load() != 0 {
		t.Fatalf("light sample read disks or load: disks %v, data dir %d, load %v, statfs calls %d", u.GetDisks(), u.GetDiskTotalBytes(), u.GetLoad1(), statfs.Load())
	}
	writeFile(t, filepath.Join(h.Proc, "stat"), "cpu  200 0 200 750 150 0 0 0 0 0\ncpu0 0\ncpu1 0\n")
	if u, _ = h.SampleLight(); u.GetCpuPercent() < 66.6 || u.GetCpuPercent() > 66.7 {
		t.Fatalf("cpu percent against the previous read = %v", u.GetCpuPercent())
	}
}

// TestNetworkRemembersPhysicalInterfaces: an interface's /sys entry is
// looked up once while it exists, not on every sample (a node with 200
// containers has 200 veths).
func TestNetworkRemembersPhysicalInterfaces(t *testing.T) {
	newHost, _ := hostFixture(t)
	h := newHost()
	if _, err := h.SampleLight(); err != nil {
		t.Fatal(err)
	}
	device := filepath.Join(h.Sys, "class", "net", "eth0", "device")
	if err := os.RemoveAll(device); err != nil {
		t.Fatal(err)
	}
	if u, _ := h.SampleLight(); u.GetNetworkRxBytes() != 1000 {
		t.Fatalf("eth0 looked up again: rx = %d", u.GetNetworkRxBytes())
	}
	// eth0 goes away and comes back: looked up again (now without a device,
	// so every non-Docker interface counts, lo excluded).
	net := filepath.Join(h.Proc, "net", "dev")
	writeFile(t, net, "head\nhead\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n")
	h.SampleLight()
	writeFile(t, net, "head\nhead\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\nveth12: 5 1 0 0 0 0 0 0 6 1 0 0 0 0 0 0\n")
	if u, _ := h.SampleLight(); u.GetNetworkRxBytes() != 1000 || u.GetNetworkTxBytes() != 2000 {
		t.Fatalf("after eth0 came back = %d/%d", u.GetNetworkRxBytes(), u.GetNetworkTxBytes())
	}
	if len(h.physical) != 2 {
		t.Fatalf("remembered %v, want only the interfaces of the last read", h.physical)
	}
}

func TestLightWatchSamplesUntilItsLeaseEnds(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, src, statfs := collectorOver(t)
		start := time.Now()
		var times []time.Time
		err := c.Watch(t.Context(), WatchOptions{Interval: 2 * time.Second, Light: true, Lease: 61 * time.Second, ServiceIDs: []string{"app"}}, func(r *agentv1.MetricsReport) error {
			if len(r.GetServices()) != 0 || len(r.GetNode().GetDisks()) != 0 || r.GetNode().GetMemoryTotalBytes() == 0 {
				t.Errorf("not a light node sample: %v", r)
			}
			times = append(times, r.GetTime().AsTime())
			return nil
		})
		if err != nil {
			t.Fatalf("a lease that runs out ends the watch without an error, got %v", err)
		}
		if took := time.Since(start); took != 61*time.Second {
			t.Fatalf("watch ran %v, want the 61s lease", took)
		}
		if len(times) != 30 || !times[0].Equal(start.Add(2*time.Second)) || !times[29].Equal(start.Add(60*time.Second)) {
			t.Fatalf("samples = %d (%v .. %v), want one every 2s from 2s to 60s", len(times), times[0].Sub(start), times[len(times)-1].Sub(start))
		}
		if src.calls.Load() != 0 || statfs.Load() != 0 {
			t.Fatalf("light watch made %d Docker calls and %d statfs calls", src.calls.Load(), statfs.Load())
		}
	})
}

func TestLightWatchStopsWhenCancelled(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, _, _ := collectorOver(t)
		ctx, cancel := context.WithCancel(t.Context())
		var sent atomic.Int64
		done := make(chan error, 1)
		// No lease, as older panels ask: it runs until the panel cancels.
		go func() {
			done <- c.Watch(ctx, WatchOptions{Light: true}, func(*agentv1.MetricsReport) error {
				sent.Add(1)
				return nil
			})
		}()
		// A second past the 300th tick, so the tick and the wake-up never tie.
		time.Sleep(10*time.Minute + time.Second)
		if got := sent.Load(); got != 300 {
			t.Fatalf("after 10 minutes without a lease: %d samples, want 300", got)
		}
		cancel()
		synctest.Wait()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled watch returned %v", err)
		}
		// Nothing samples once the watch returned.
		time.Sleep(time.Hour)
		if got := sent.Load(); got != 300 {
			t.Fatalf("samples after the cancel: %d", got-300)
		}
	})
}

// TestLeaseRenewalOverlaps is what the panel does while somebody watches:
// it opens the next watch a few seconds before the current lease ends, so
// samples never pause, and each watch stops at its own lease.
func TestLeaseRenewalOverlaps(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, _, _ := collectorOver(t)
		start := time.Now()
		type sample struct {
			watch string
			at    time.Duration
		}
		samples := make(chan sample, 200)
		ended := make(chan string, 2)
		run := func(name string) {
			err := c.Watch(t.Context(), WatchOptions{Interval: 2 * time.Second, Light: true, Lease: 61 * time.Second}, func(r *agentv1.MetricsReport) error {
				samples <- sample{name, r.GetTime().AsTime().Sub(start)}
				return nil
			})
			if err != nil {
				t.Errorf("%s: %v", name, err)
			}
			ended <- name
		}
		go run("first")
		time.Sleep(56 * time.Second) // the renewal: 5 s before the first lease ends
		go run("second")
		time.Sleep(10 * time.Second)
		synctest.Wait()
		if got := <-ended; got != "first" {
			t.Fatalf("%s ended first", got)
		}
		time.Sleep(time.Minute)
		synctest.Wait()
		if got := <-ended; got != "second" {
			t.Fatalf("%s ended second", got)
		}
		close(samples)
		var last time.Duration
		counts := map[string]int{}
		for s := range samples {
			if s.at-last > 2*time.Second {
				t.Fatalf("a %v pause in the samples before %s's sample at %v", s.at-last, s.watch, s.at)
			}
			last = max(last, s.at)
			counts[s.watch]++
		}
		if counts["first"] != 30 || counts["second"] != 30 || last != 116*time.Second {
			t.Fatalf("samples %v, last at %v", counts, last)
		}
	})
}

func TestWatchLeaseHasAMinimum(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, _, _ := collectorOver(t)
		start := time.Now()
		n := 0
		err := c.Watch(t.Context(), WatchOptions{Interval: 3 * time.Second, Light: true, Lease: time.Second}, func(*agentv1.MetricsReport) error {
			n++
			return nil
		})
		if err != nil || time.Since(start) != MinWatchLease || n != 3 {
			t.Fatalf("1s lease: ran %v with %d samples (%v), want %v and 3", time.Since(start), n, err, MinWatchLease)
		}
	})
}

// TestFullWatchStillSamplesDisksAndServices: without light a watch reads
// what it did before (older panels and the service metrics view).
func TestFullWatchStillSamplesDisksAndServices(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, src, statfs := collectorOver(t)
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		var got []*agentv1.MetricsReport
		_ = c.Watch(ctx, WatchOptions{Interval: time.Second}, func(r *agentv1.MetricsReport) error {
			got = append(got, r)
			cancel()
			return nil
		})
		if len(got) != 1 || len(got[0].GetNode().GetDisks()) != 2 || got[0].GetNode().GetLoad1() != 0.5 || statfs.Load() == 0 {
			t.Fatalf("node-only full sample = %v", got)
		}
		if src.calls.Load() != 0 {
			t.Fatalf("node-only watch made %d Docker calls", src.calls.Load())
		}
		ctx, cancel = context.WithCancel(t.Context())
		defer cancel()
		_ = c.Watch(ctx, WatchOptions{Interval: time.Second, ServiceIDs: []string{"app"}}, func(r *agentv1.MetricsReport) error {
			cancel()
			return nil
		})
		if src.calls.Load() == 0 {
			t.Fatal("a watch of a service never asked Docker")
		}
	})
}
