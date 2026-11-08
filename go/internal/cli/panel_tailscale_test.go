//go:build !windows

package cli

import (
	"errors"
	"testing"

	"github.com/seylo-dev/app/go/internal/stub"
)

// The commands are registered and say plainly that they are not built yet,
// and run nothing on the host meanwhile. WP-F3a replaces this test.
func TestPanelTailscaleNotBuiltYet(t *testing.T) {
	for _, sub := range []string{"status", "off", "on"} {
		h := newHarness(t)
		h.euid = 0
		if _, err := h.run("panel", "tailscale", sub); !errors.Is(err, stub.ErrNotImplemented) {
			t.Fatalf("panel tailscale %s = %v, want not implemented yet", sub, err)
		}
		if len(h.cmds) != 0 || len(h.units.calls) != 0 {
			t.Fatalf("panel tailscale %s ran %v and %v", sub, h.cmds, h.units.calls)
		}
	}
}
