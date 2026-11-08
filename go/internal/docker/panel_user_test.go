package docker

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The panel image builds in the same panel user the agent gives the
// panel's folder to and starts the panel container with.
func TestPanelImageUsesThePanelUser(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "deploy", "panel.Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}
	dockerfile := string(b)
	if want := fmt.Sprintf("ARG PANEL_UID=%d\n", PanelUID); !strings.Contains(dockerfile, want) || PanelUID != PanelGID {
		t.Fatalf("deploy/panel.Dockerfile has no %q (PanelUID %d, PanelGID %d)", strings.TrimSpace(want), PanelUID, PanelGID)
	}
	for _, line := range strings.Split(dockerfile, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "USER ") {
			t.Fatalf("deploy/panel.Dockerfile sets %q: the entrypoint picks the user", line)
		}
	}
	if PanelUser != "61000:61000" {
		t.Fatalf("PanelUser = %q", PanelUser)
	}
}
