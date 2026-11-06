package wings

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// Default CPU weights of seylo.slice (cgroup v2 cpu.weight, 1-10000).
// Game servers stay at the default 100, so "games first" gives them about
// five times our share when the CPU is contended; nothing is capped.
const (
	NormalWeight     = 100
	GamesFirstWeight = 20
)

// SliceCPU sets the CPU weight of the slice every Seylo container runs
// under (docker.CgroupParent).
type SliceCPU struct {
	// CgroupRoot is the cgroup v2 mount ("/sys/fs/cgroup").
	CgroupRoot string
	// Slice is "seylo.slice".
	Slice string
	// SystemdDriver: Docker uses the systemd cgroup driver, so the slice
	// is a systemd unit and the weight goes through systemctl (persisted).
	// Otherwise (cgroupfs) the agent writes cpu.weight itself.
	SystemdDriver bool
	// Systemctl runs systemctl (tests replace it).
	Systemctl func(ctx context.Context, args ...string) error
	// DetectDriver, when set, decides SystemdDriver on the first apply
	// (asking Docker for its cgroup driver).
	DetectDriver func(ctx context.Context) (systemd bool, err error)

	mu      sync.Mutex
	applied *bool
}

// NewSliceCPU returns the production setter; detect reports whether
// Docker uses the systemd cgroup driver.
func NewSliceCPU(slice string, detect func(ctx context.Context) (bool, error)) *SliceCPU {
	return &SliceCPU{CgroupRoot: "/sys/fs/cgroup", Slice: slice, DetectDriver: detect, Systemctl: runSystemctl}
}

func runSystemctl(ctx context.Context, args ...string) error {
	out, err := exec.CommandContext(ctx, "systemctl", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// SetGamesFirst implements CPUPriority. It only touches the system when the
// setting changed since the last call (the first call always applies, so a
// restart restores what the desired state says).
func (c *SliceCPU) SetGamesFirst(ctx context.Context, enabled bool) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.applied != nil && *c.applied == enabled {
		return nil
	}
	if c.applied == nil && !enabled && !c.exists() {
		// Never enabled and nothing to restore.
		c.applied = &enabled
		return nil
	}
	if c.DetectDriver != nil {
		systemd, err := c.DetectDriver(ctx)
		if err != nil {
			return fmt.Errorf("finding Docker's cgroup driver: %w", err)
		}
		c.SystemdDriver, c.DetectDriver = systemd, nil
	}
	weight := NormalWeight
	if enabled {
		weight = GamesFirstWeight
	}
	var err error
	if c.SystemdDriver {
		err = c.Systemctl(ctx, "set-property", c.Slice, "CPUWeight="+strconv.Itoa(weight))
	} else {
		err = c.writeWeight(weight)
	}
	if err != nil {
		return err
	}
	c.applied = &enabled
	return nil
}

func (c *SliceCPU) dir() string { return filepath.Join(c.CgroupRoot, c.Slice) }

func (c *SliceCPU) exists() bool {
	_, err := os.Stat(c.dir())
	return err == nil
}

// writeWeight creates the slice's cgroup when missing (Docker would create
// it on the first container) and writes cpu.weight.
func (c *SliceCPU) writeWeight(weight int) error {
	if err := os.MkdirAll(c.dir(), 0o755); err != nil {
		return fmt.Errorf("creating cgroup %s: %w", c.Slice, err)
	}
	file := filepath.Join(c.dir(), "cpu.weight")
	err := os.WriteFile(file, []byte(strconv.Itoa(weight)), 0o644)
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, os.ErrPermission) {
		// The cpu controller is not enabled for children of the root.
		if e := os.WriteFile(filepath.Join(c.CgroupRoot, "cgroup.subtree_control"), []byte("+cpu"), 0o644); e == nil {
			err = os.WriteFile(file, []byte(strconv.Itoa(weight)), 0o644)
		}
	}
	if err != nil {
		return fmt.Errorf("setting %s cpu.weight: %w", c.Slice, err)
	}
	return nil
}

var _ CPUPriority = (*SliceCPU)(nil)
