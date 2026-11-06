package metrics

// Memory and CPU formulas ported from the Wings fork's
// environment/docker/stats.go (MIT, Copyright (c) 2018 - 2021 Dane Everitt
// and Contributors), which follows the Docker CLI's stats helpers.

import (
	"context"
	"slices"
	"strings"
	"sync"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/console/dockerapi"
)

// Source is the Docker side of sampling. *dockerapi.Client implements it.
type Source interface {
	ListContainers(ctx context.Context, all bool, labels map[string]string) ([]dockerapi.Container, error)
	StatsOnce(ctx context.Context, id string) (*dockerapi.Stats, error)
}

// containerMemory is usage - inactive_file, what `docker stats` shows and
// roughly what the kernel cannot reclaim. Raw usage counts page cache, so a
// service that reads files looks like it leaks memory (Easypanel shows
// that). cgroup v1 names the stat total_inactive_file, v2 inactive_file.
func containerMemory(m dockerapi.MemoryStats) uint64 {
	if v, ok := m.Stats["total_inactive_file"]; ok && v < m.Usage {
		return m.Usage - v
	}
	if v, ok := m.Stats["inactive_file"]; ok && v < m.Usage {
		return m.Usage - v
	}
	return m.Usage
}

// cpuSample is what CPU percent needs from the previous stats read.
type cpuSample struct {
	container, system uint64
}

// containerCPU is the container's share of one core times 100, summed over
// cores (200 = two full cores), like `docker stats`.
func containerCPU(prev cpuSample, s *dockerapi.Stats) float64 {
	cur := cpuSample{s.CPUStats.CPUUsage.TotalUsage, s.CPUStats.SystemUsage}
	if prev.system == 0 || cur.system <= prev.system || cur.container < prev.container {
		return 0
	}
	cpus := float64(s.CPUStats.OnlineCPUs)
	if cpus == 0 {
		cpus = float64(len(s.CPUStats.CPUUsage.PercpuUsage))
	}
	if cpus == 0 {
		cpus = 1
	}
	return float64(cur.container-prev.container) / float64(cur.system-prev.system) * cpus * 100
}

// sampler turns stats reads into per-service usage. It keeps the previous
// CPU counters per container; one sampler belongs to one goroutine.
type sampler struct {
	src  Source
	host *Host
	prev map[string]cpuSample
}

func newSampler(src Source, host *Host) *sampler {
	return &sampler{src: src, host: host, prev: map[string]cpuSample{}}
}

// statsConcurrency bounds parallel stats calls to the daemon.
const statsConcurrency = 8

// services samples the running containers of the given services (all
// services when the filter is empty), summed per service.
func (s *sampler) services(ctx context.Context, only []string, memTotal uint64) ([]*agentv1.ServiceUsage, error) {
	if slices.Equal(only, nodeOnly) {
		return nil, nil
	}
	list, err := s.src.ListContainers(ctx, false, nil)
	if err != nil {
		return nil, err
	}
	list = slices.DeleteFunc(list, func(c dockerapi.Container) bool {
		svc := c.ServiceID()
		return svc == "" || !c.Running() || (len(only) > 0 && !slices.Contains(only, svc))
	})

	type result struct {
		c     dockerapi.Container
		stats *dockerapi.Stats
	}
	results := make([]result, len(list))
	var wg sync.WaitGroup
	sem := make(chan struct{}, statsConcurrency)
	for i, c := range list {
		wg.Go(func() {
			sem <- struct{}{}
			defer func() { <-sem }()
			st, err := s.src.StatsOnce(ctx, c.ID)
			if err == nil {
				results[i] = result{c, st}
			}
		})
	}
	wg.Wait()

	bySvc := map[string]*agentv1.ServiceUsage{}
	unlimited := map[string]bool{}
	seen := map[string]bool{}
	for _, r := range results {
		if r.stats == nil {
			continue
		}
		id := r.c.ID
		seen[id] = true
		svc := r.c.ServiceID()
		u := bySvc[svc]
		if u == nil {
			u = &agentv1.ServiceUsage{ServiceId: svc}
			bySvc[svc] = u
		}
		st := r.stats
		u.Instances++
		u.CpuPercent += containerCPU(s.prev[id], st)
		s.prev[id] = cpuSample{st.CPUStats.CPUUsage.TotalUsage, st.CPUStats.SystemUsage}
		u.MemoryUsedBytes += containerMemory(st.MemoryStats)
		// Without a limit Docker reports the host's memory as the limit.
		if lim := st.MemoryStats.Limit; lim == 0 || (memTotal > 0 && lim >= memTotal) {
			unlimited[svc] = true
		} else {
			u.MemoryLimitBytes += lim
		}
		for _, n := range st.Networks {
			u.NetworkRxBytes += n.RxBytes
			u.NetworkTxBytes += n.TxBytes
		}
		// cgroup v1 says "Read"/"Write", v2 "read"/"write".
		for _, b := range st.BlkioStats.IoServiceBytesRecursive {
			switch {
			case strings.EqualFold(b.Op, "read"):
				u.BlockReadBytes += b.Value
			case strings.EqualFold(b.Op, "write"):
				u.BlockWriteBytes += b.Value
			}
		}
	}
	// Forget containers that are gone so the map does not grow forever.
	if len(only) == 0 {
		for id := range s.prev {
			if !seen[id] {
				delete(s.prev, id)
			}
		}
	}
	out := make([]*agentv1.ServiceUsage, 0, len(bySvc))
	for svc, u := range bySvc {
		if unlimited[svc] {
			u.MemoryLimitBytes = 0
		}
		out = append(out, u)
	}
	slices.SortFunc(out, func(a, b *agentv1.ServiceUsage) int { return strings.Compare(a.ServiceId, b.ServiceId) })
	return out, nil
}
