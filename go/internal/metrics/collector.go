package metrics

import (
	"context"
	"slices"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Collector samples usage.
type Collector interface {
	// Run samples on a fixed interval until ctx ends, calling publish with
	// every sample (the agent sends it to the panel).
	Run(ctx context.Context, publish func(*agentv1.MetricsReport)) error
	// History returns retained samples since t, filtered to serviceIDs
	// (node usage only when empty).
	History(since time.Time, serviceIDs []string) []*agentv1.MetricsReport
	// Watch streams fresh samples at interval until ctx ends.
	Watch(ctx context.Context, interval time.Duration, serviceIDs []string, fn func(*agentv1.MetricsReport) error) error
}

// Defaults.
const (
	DefaultInterval = 10 * time.Second
	// HistoryWindow is what the agent keeps for GetMetrics; longer ranges
	// come from the panel's rollups.
	HistoryWindow = time.Hour
	// MinWatchInterval and DefaultWatchInterval bound WatchMetrics.
	MinWatchInterval     = time.Second
	DefaultWatchInterval = 2 * time.Second
)

// DockerCollector is the Collector of a node: /proc for the node, Docker
// stats for containers. The periodic samples live in memory for an hour.
type DockerCollector struct {
	src      Source
	newHost  func() *Host
	interval time.Duration
	now      func() time.Time

	mu      sync.Mutex
	history []*agentv1.MetricsReport // oldest first
}

var _ Collector = (*DockerCollector)(nil)

// NewDockerCollector samples every interval (DefaultInterval when 0).
// dataDir names the filesystem reported as the node's disk.
func NewDockerCollector(src Source, dataDir string, interval time.Duration) *DockerCollector {
	if interval <= 0 {
		interval = DefaultInterval
	}
	return &DockerCollector{
		src:      src,
		newHost:  func() *Host { return NewHost(dataDir) },
		interval: interval,
		now:      time.Now,
	}
}

// sample takes one report with a sampler's state (CPU deltas).
func (c *DockerCollector) sample(ctx context.Context, host *Host, s *sampler, only []string) (*agentv1.MetricsReport, error) {
	r := &agentv1.MetricsReport{Time: timestamppb.New(c.now())}
	node, err := host.Sample()
	if err != nil {
		return nil, err
	}
	r.Node = node
	if r.Services, err = s.services(ctx, only, node.GetMemoryTotalBytes()); err != nil {
		r.Services = nil // Docker down: still report the node
	}
	return r, nil
}

// Run implements Collector.
func (c *DockerCollector) Run(ctx context.Context, publish func(*agentv1.MetricsReport)) error {
	host := c.newHost()
	s := newSampler(c.src, host)
	// Prime the CPU counters so the first published sample is meaningful.
	if _, err := c.sample(ctx, host, s, nil); err != nil {
		return err
	}
	t := time.NewTicker(c.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
		r, err := c.sample(ctx, host, s, nil)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		c.record(r)
		publish(r)
	}
}

func (c *DockerCollector) record(r *agentv1.MetricsReport) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.history = append(c.history, r)
	cutoff := r.GetTime().AsTime().Add(-HistoryWindow)
	drop := 0
	for drop < len(c.history) && c.history[drop].GetTime().AsTime().Before(cutoff) {
		drop++
	}
	if drop > 0 {
		c.history = slices.Clone(c.history[drop:])
	}
}

// History implements Collector.
func (c *DockerCollector) History(since time.Time, serviceIDs []string) []*agentv1.MetricsReport {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []*agentv1.MetricsReport
	for _, r := range c.history {
		if !since.IsZero() && !r.GetTime().AsTime().After(since) {
			continue
		}
		out = append(out, filterReport(r, serviceIDs))
	}
	return out
}

// filterReport copies r keeping only the listed services (none when the
// list is empty).
func filterReport(r *agentv1.MetricsReport, serviceIDs []string) *agentv1.MetricsReport {
	out := &agentv1.MetricsReport{Time: r.GetTime(), Node: r.GetNode()}
	for _, s := range r.GetServices() {
		if slices.Contains(serviceIDs, s.GetServiceId()) {
			out.Services = append(out.Services, proto.CloneOf(s))
		}
	}
	return out
}

// nodeOnly is a service filter that matches no container.
var nodeOnly = []string{"\x00"}

// Watch implements Collector. It samples on its own (not the 10s loop) so
// an open chart moves every couple of seconds.
func (c *DockerCollector) Watch(ctx context.Context, interval time.Duration, serviceIDs []string, fn func(*agentv1.MetricsReport) error) error {
	if interval == 0 {
		interval = DefaultWatchInterval
	}
	interval = max(interval, MinWatchInterval)
	host := c.newHost()
	s := newSampler(c.src, host)
	only := serviceIDs
	if len(only) == 0 {
		only = nodeOnly
	}
	if _, err := c.sample(ctx, host, s, only); err != nil {
		return err
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
		r, err := c.sample(ctx, host, s, only)
		if err != nil {
			return err
		}
		if err := fn(filterReport(r, serviceIDs)); err != nil {
			return err
		}
	}
}
