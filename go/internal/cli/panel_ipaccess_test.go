//go:build !windows

package cli

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/seylo-dev/app/go/internal/localapi"
)

// panelNode makes h's data dir look like the panel's node: <data>/panel
// with panel.db and master.key. It returns the panel folder.
func panelNode(t *testing.T, h *harness) string {
	t.Helper()
	dir := filepath.Join(h.dataDir, "panel")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"panel.db": "rows", "master.key": "the-key\n"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// recordChown replaces chownPanelFile for the test and returns the owners
// it was asked for, by file name.
func recordChown(t *testing.T) map[string][2]int {
	t.Helper()
	saved := chownPanelFile
	t.Cleanup(func() { chownPanelFile = saved })
	got := map[string][2]int{}
	chownPanelFile = func(f *os.File, uid, gid int) error {
		got[filepath.Base(f.Name())] = [2]int{uid, gid}
		return nil
	}
	return got
}

const panelPS = "seylo-registry-1\tregistry:2\tregistry0000000\nseylo-panel00000000000-3\tghcr.io/seylo-dev/seylo:0.2.1\tpanel00000000000"

// `seylo panel ip-access on` writes <data>/panel/ip-access-on (0600, for
// the panel user) and restarts the running panel container.
func TestPanelIPAccessOn(t *testing.T) {
	h := newHarness(t)
	h.euid = 0
	dir := panelNode(t, h)
	owners := recordChown(t)
	h.answer = func(cmd string) (string, error) {
		if strings.HasPrefix(cmd, "docker ps") {
			return panelPS, nil
		}
		return "", nil
	}
	out, err := h.run("panel", "ip-access", "on")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, ipAccessOnFile)
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		t.Fatalf("%s is %v, want a 0600 file", path, info.Mode())
	}
	if got := owners[ipAccessOnFile]; got != [2]int{panelUID, panelGID} {
		t.Fatalf("owner = %v, want the panel user %d:%d", got, panelUID, panelGID)
	}
	if last := h.cmds[len(h.cmds)-1]; last != "docker restart seylo-panel00000000000-3" {
		t.Fatalf("commands = %v", h.cmds)
	}
	if !strings.Contains(out, "restarts once more") || !strings.Contains(out, "seylo panel status") {
		t.Fatalf("output = %s", out)
	}
}

// Whatever the panel container left at the marker's name is replaced, not
// followed: a link to master.key or to a file outside the folder leaves
// both as they were.
func TestPanelIPAccessOnReplacesLinks(t *testing.T) {
	for name, target := range map[string]func(dir string) string{
		"master.key": func(dir string) string { return filepath.Join(dir, "master.key") },
		"outside":    func(string) string { return filepath.Join(t.TempDir(), "shadow") },
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			h.euid = 0
			dir := panelNode(t, h)
			recordChown(t)
			to := target(dir)
			if _, err := os.Stat(to); errors.Is(err, os.ErrNotExist) {
				if err := os.WriteFile(to, []byte("root:x:0:0\n"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := os.ReadFile(to)
			if err := os.Symlink(to, filepath.Join(dir, ipAccessOnFile)); err != nil {
				t.Fatal(err)
			}
			h.answer = func(cmd string) (string, error) {
				if strings.HasPrefix(cmd, "docker ps") {
					return panelPS, nil
				}
				return "", nil
			}
			if _, err := h.run("panel", "ip-access", "on"); err != nil {
				t.Fatal(err)
			}
			if after, _ := os.ReadFile(to); !bytes.Equal(after, before) {
				t.Fatalf("%s changed to %q", to, after)
			}
			info, err := os.Lstat(filepath.Join(dir, ipAccessOnFile))
			if err != nil || !info.Mode().IsRegular() {
				t.Fatalf("marker = %v, %v; want a new regular file", info, err)
			}
		})
	}
}

func TestPanelIPAccessOnRefuses(t *testing.T) {
	// Not root: nothing runs.
	h := newHarness(t)
	panelNode(t, h)
	if _, err := h.run("panel", "ip-access", "on"); err == nil || !strings.Contains(err.Error(), "sudo seylo panel ip-access on") {
		t.Fatalf("as a user = %v", err)
	}
	if len(h.cmds) != 0 {
		t.Fatalf("ran %v", h.cmds)
	}
	// Not the panel's node.
	h = newHarness(t)
	h.euid = 0
	if _, err := h.run("panel", "ip-access", "on"); err == nil || !strings.Contains(err.Error(), "does not run the panel") {
		t.Fatalf("on another node = %v", err)
	}
	if len(h.cmds) != 0 {
		t.Fatalf("ran %v", h.cmds)
	}
}

// A stopped panel picks the marker up when it starts; nothing is restarted.
// A failed restart says the next start reopens it.
func TestPanelIPAccessOnWithoutARunningPanel(t *testing.T) {
	h := newHarness(t)
	h.euid = 0
	dir := panelNode(t, h)
	recordChown(t)
	h.answer = func(cmd string) (string, error) { return "", nil }
	out, err := h.run("panel", "ip-access", "on")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, ipAccessOnFile)); err != nil {
		t.Fatalf("no marker: %v", err)
	}
	if !strings.Contains(out, "seylo panel start") {
		t.Fatalf("output = %s", out)
	}
	for _, c := range h.cmds {
		if strings.HasPrefix(c, "docker restart") {
			t.Fatalf("restarted with no panel running: %v", h.cmds)
		}
	}

	h.answer = func(cmd string) (string, error) {
		if strings.HasPrefix(cmd, "docker ps") {
			return panelPS, nil
		}
		return "", errors.New("exit status 1")
	}
	if _, err := h.run("panel", "ip-access", "on"); err == nil || !strings.Contains(err.Error(), "opens IP access on its next start") {
		t.Fatalf("failed restart = %v", err)
	}
}

func TestPrintPanelStatus(t *testing.T) {
	var b bytes.Buffer
	err := printPanelStatus(&b, localapi.PanelStatus{
		Running: true, Version: "0.2.1", URL: "http://127.0.0.1:3000", Phase: "running",
		IPAccess:  localapi.PortAccess{State: localapi.PortClosed, Bindings: []string{"127.0.0.1:3000"}},
		AgentPort: localapi.PortAccess{State: localapi.PortOpen, Bindings: []string{"0.0.0.0:3443"}},
	})
	want := "Panel running (running), version 0.2.1, http://127.0.0.1:3000\n" +
		"IP access: closed (127.0.0.1:3000); agents' port: open (0.0.0.0:3443)\n"
	if err != nil || b.String() != want {
		t.Fatalf("got %q, %v\nwant %q", b.String(), err, want)
	}

	b.Reset()
	_ = printPanelStatus(&b, localapi.PanelStatus{Phase: "failed", Version: "0.2.1", URL: "u",
		IPAccess: localapi.PortAccess{State: localapi.PortUnknown}, AgentPort: localapi.PortAccess{State: localapi.PortOff}})
	if !strings.Contains(b.String(), "IP access: unknown (the panel container is not running); agents' port: off\n") {
		t.Fatalf("stopped = %q", b.String())
	}

	// An agent from before 0.2.1 reports no bindings: one line, as before.
	b.Reset()
	_ = printPanelStatus(&b, localapi.PanelStatus{Phase: "running", Running: true, Version: "0.2.0", URL: "u"})
	if b.String() != "Panel running (running), version 0.2.0, u\n" {
		t.Fatalf("old agent = %q", b.String())
	}
}
