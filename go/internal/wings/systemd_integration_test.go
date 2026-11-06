//go:build integration

package wings

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/seylo-dev/app/go/internal/proxy"
)

// TestIntegrationSliceCPUWeightSystemd: with Docker's systemd cgroup driver
// the slice is a systemd unit and the weight goes through systemctl. Runs
// in a VM whose Docker uses native.cgroupdriver=systemd (SEYLO_VM=seylo-sd);
// skipped elsewhere.
func TestIntegrationSliceCPUWeightSystemd(t *testing.T) {
	prefix := itPrefix(t)
	d, err := proxy.NewMobyDocker()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	systemd, err := d.SystemdCgroupDriver(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !systemd {
		t.Skip("Docker uses cgroupfs here; run in the systemd-driver VM")
	}
	// A dash in a slice name means nesting under systemd, so none here
	// (seylo.slice has none either).
	slice := strings.ReplaceAll(prefix, "-", "") + ".slice"
	name := prefix + "-c"
	// A container under the slice, as Docker starts ours (the slice unit
	// appears with its first scope).
	if out, err := exec.Command("docker", "run", "-d", "--name", name, "--cgroup-parent", slice, "busybox:1.37", "sleep", "300").CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "-f", name).Run()
		_ = exec.Command("systemctl", "stop", slice).Run()
		_ = os.RemoveAll(filepath.Join("/etc/systemd/system.control", slice+".d"))
		_ = exec.Command("systemctl", "daemon-reload").Run()
	})
	c := NewSliceCPU(slice, d.SystemdCgroupDriver)
	read := func() string {
		b, err := os.ReadFile(filepath.Join("/sys/fs/cgroup", slice, "cpu.weight"))
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(b))
	}
	if err := c.SetGamesFirst(ctx, true); err != nil {
		t.Fatal(err)
	}
	if !c.SystemdDriver {
		t.Fatal("the systemd driver was not detected")
	}
	if w := read(); w != "20" {
		t.Fatalf("games first: cpu.weight = %s", w)
	}
	out, _ := exec.Command("systemctl", "show", slice, "-p", "CPUWeight").Output()
	if strings.TrimSpace(string(out)) != "CPUWeight=20" {
		t.Fatalf("systemd property: %q", out)
	}
	if err := c.SetGamesFirst(ctx, false); err != nil {
		t.Fatal(err)
	}
	if w := read(); w != "100" {
		t.Fatalf("restored: cpu.weight = %s", w)
	}
}
