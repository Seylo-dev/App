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
	// History returns the retained samples newer than since (all when
	// zero), filtered to serviceIDs (node usage only when empty). Only the
	// latest periodic sample is retained: the panel keeps its own live
	// window and rollups, and nothing reads a longer history from a node.
	History(since time.Time, serviceIDs []string) []*agentv1.MetricsReport
	// Watch streams fresh samples until ctx ends or its lease runs out
	// (then it returns nil).
	Watch(ctx context.Context, o WatchOptions, fn func(*agentv1.MetricsReport) error) error
}

// WatchOptions say what one WatchMetrics stream sends.
type WatchOptions struct {
	// Interval between samples: DefaultWatchInterval when 0, at least
	// MinWatchInterval.
	Interval time.Duration
	// ServiceIDs to include; empty = node usage only.
	ServiceIDs []string
	// Light samples the node's CPU, memory and network counters only
	// (Host.SampleLight); ServiceIDs is ignored.
	Light bool
	// Lease ends the watch (nil error) this long after it started, at least
	// MinWatchLease; 0 = until ctx ends.
	Lease time.Duration
}

// Defaults.
const (
	DefaultInterval = 10 * time.Second
	// MinWatchInterval and DefaultWatchInterval bound WatchMetrics.
	MinWatchInterval     = time.Second
	DefaultWatchInterval = 2 * time.Second
	// MinWatchLease keeps a short lease from turning into a stream of
	// reopened watches.
	MinWatchLease = 10 * time.Second
)

// DockerCollector is the Collector of a node: /proc for the node, Docker
// stats for containers. Only the latest periodic sample stays in memory
// (an hour of full reports was about 11 MiB per 200 services, kept for an
// RPC nothing calls).
type DockerCollector struct {
	src      Source
	newHost  func() *Host
	interval time.Duration
	now      func() time.Time

	mu     sync.Mutex
	latest *agentv1.MetricsReport
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
	c.latest = r
}

// History implements Collector: the latest sample, when newer than since.
func (c *DockerCollector) History(since time.Time, serviceIDs []string) []*agentv1.MetricsReport {
	c.mu.Lock()
	defer c.mu.Unlock()
	r := c.latest
	if r == nil || !since.IsZero() && !r.GetTime().AsTime().After(since) {
		return nil
	}
	return []*agentv1.MetricsReport{filterReport(r, serviceIDs)}
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
// an open chart moves every couple of seconds, with its own Host (CPU
// percent is against its own previous read). Nothing of it runs once it
// returns: the panel's cancel, a dropped connection and the lease all end
// it, and a panel that stops reading leaves it blocked in fn.
func (c *DockerCollector) Watch(ctx context.Context, o WatchOptions, fn func(*agentv1.MetricsReport) error) error {
	interval := o.Interval
	if interval == 0 {
		interval = DefaultWatchInterval
	}
	interval = max(interval, MinWatchInterval)
	var leaseEnd <-chan time.Time
	if o.Lease > 0 {
		lease := time.NewTimer(max(o.Lease, MinWatchLease))
		defer lease.Stop()
		leaseEnd = lease.C
	}
	take := c.watchSampler(o)
	// Prime the CPU counters so the first sample sent is meaningful.
	if _, err := take(ctx); err != nil {
		return err
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-leaseEnd:
			return nil
		case <-t.C:
		}
		r, err := take(ctx)
		if err != nil {
			return err
		}
		if err := fn(r); err != nil {
			return err
		}
	}
}

// watchSampler returns what one watch samples with: the light node read,
// or the node plus the listed services (none when the list is empty).
func (c *DockerCollector) watchSampler(o WatchOptions) func(context.Context) (*agentv1.MetricsReport, error) {
	host := c.newHost()
	if o.Light {
		return func(context.Context) (*agentv1.MetricsReport, error) {
			node, err := host.SampleLight()
			if err != nil {
				return nil, err
			}
			return &agentv1.MetricsReport{Time: timestamppb.New(c.now()), Node: node}, nil
		}
	}
	s := newSampler(c.src, host)
	only := o.ServiceIDs
	if len(only) == 0 {
		only = nodeOnly
	}
	return func(ctx context.Context) (*agentv1.MetricsReport, error) {
		r, err := c.sample(ctx, host, s, only)
		if err != nil {
			return nil, err
		}
		return filterReport(r, o.ServiceIDs), nil
	}
}
