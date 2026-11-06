package dockerapi

import (
	"context"
	"net/http"
	"net/url"
	"time"
)

// Stats is the part of a container stats answer we read. The same shape
// comes from cgroup v1 and v2 hosts; only the memory stat keys differ.
type Stats struct {
	Read     time.Time `json:"read"`
	CPUStats struct {
		CPUUsage struct {
			TotalUsage  uint64   `json:"total_usage"`
			PercpuUsage []uint64 `json:"percpu_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs  uint32 `json:"online_cpus"`
	} `json:"cpu_stats"`
	MemoryStats MemoryStats `json:"memory_stats"`
	Networks    map[string]struct {
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
	BlkioStats struct {
		IoServiceBytesRecursive []struct {
			Op    string `json:"op"`
			Value uint64 `json:"value"`
		} `json:"io_service_bytes_recursive"`
	} `json:"blkio_stats"`
}

// MemoryStats is the memory part of Stats.
type MemoryStats struct {
	Usage uint64            `json:"usage"`
	Limit uint64            `json:"limit"`
	Stats map[string]uint64 `json:"stats"`
}

// StatsOnce reads one stats sample without waiting for a second one (the
// "one-shot" mode). CPU percent needs two samples, so callers keep the
// previous one.
func (c *Client) StatsOnce(ctx context.Context, id string) (*Stats, error) {
	var out Stats
	q := url.Values{"stream": {"0"}, "one-shot": {"1"}}
	if err := c.getJSON(ctx, http.MethodGet, "/containers/"+url.PathEscape(id)+"/stats", q, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
