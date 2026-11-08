package agent

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// Agents before 0.2.0-rc.2 made services/ and services/<id>/ 0755 under
// the 0711 data dir, so a local account could read file mounts and volume
// data; the agent closes them when it starts, before anything is
// deployed again.
func TestStartClosesServiceFolders(t *testing.T) {
	isolate(t)
	panel := rpctest.NewFakePanel(t)
	panel.AddJoinToken("tok1")
	layout := shortLayout(t)
	if err := Join(layout, JoinOptions{PanelURL: panel.URL(), Token: "tok1", Name: "edge-1"}); err != nil {
		t.Fatal(err)
	}
	services := filepath.Join(layout.Root(), "services")
	svc := filepath.Join(services, "web")
	if err := os.MkdirAll(filepath.Join(svc, "files"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{services, svc} {
		if err := os.Chmod(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	r := startDaemon(t, layout)
	defer r.stop(t)
	for _, dir := range []string{services, svc} {
		st, err := os.Stat(dir)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o700 {
			t.Errorf("%s is %v after the agent started", dir, st.Mode().Perm())
		}
	}
}
