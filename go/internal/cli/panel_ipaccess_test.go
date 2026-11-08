//go:build !windows

package cli

import (
	"errors"
	"testing"

	"github.com/seylo-dev/app/go/internal/stub"
)

// The command is registered and says plainly that it is not built yet, and
// runs nothing on the host meanwhile. WP-F2a replaces this test.
func TestPanelIPAccessOnNotBuiltYet(t *testing.T) {
	h := newHarness(t)
	h.euid = 0
	if _, err := h.run("panel", "ip-access", "on"); !errors.Is(err, stub.ErrNotImplemented) {
		t.Fatalf("panel ip-access on = %v, want not implemented yet", err)
	}
	if len(h.cmds) != 0 || len(h.units.calls) != 0 {
		t.Fatalf("ran %v and %v", h.cmds, h.units.calls)
	}
}
