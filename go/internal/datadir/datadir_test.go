package datadir

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/seylo-dev/app/go/gen/brand"
)

func TestDefaultUsesBrandDataDir(t *testing.T) {
	if got := Default().Root(); got != brand.DataDir {
		t.Fatalf("Root() = %q, want %q", got, brand.DataDir)
	}
}

func TestServicePaths(t *testing.T) {
	l := New("/data/")
	vol, err := l.ServiceVolume("svc_1", "pgdata")
	if err != nil {
		t.Fatal(err)
	}
	if want := "/data/services/svc_1/volumes/pgdata"; vol != want {
		t.Fatalf("ServiceVolume = %q, want %q", vol, want)
	}
	logs, err := l.ServiceLogs("svc_1")
	if err != nil || logs != "/data/logs/svc_1" {
		t.Fatalf("ServiceLogs = %q, %v", logs, err)
	}
	if got := l.AgentSocket(); got != "/data/run/agent.sock" {
		t.Fatalf("AgentSocket = %q", got)
	}
}

func TestRejectsIDsThatEscape(t *testing.T) {
	l := New("/data")
	for _, id := range []string{"", "..", "../etc", "a/b", "A", "-x", ".hidden", "a b"} {
		if _, err := l.ServiceDir(id); !errors.Is(err, ErrInvalidID) {
			t.Errorf("ServiceDir(%q) err = %v", id, err)
		}
		if _, err := l.ServiceVolume("ok", id); !errors.Is(err, ErrInvalidID) {
			t.Errorf("ServiceVolume(ok, %q) err = %v", id, err)
		}
	}
}

func mode(t *testing.T, path string) os.FileMode {
	t.Helper()
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return st.Mode().Perm()
}

// TestServiceFoldersArePrivate: services/ and services/<id>/ are 0700 so
// a local account cannot reach file mounts and volume data (the data dir
// is 0711), including folders an older agent made 0755.
func TestServiceFoldersArePrivate(t *testing.T) {
	root := t.TempDir()
	l := New(root)
	vol, err := l.MakeServiceVolume("svc_1", "pgdata")
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{l.ServicesDir(), filepath.Dir(filepath.Dir(vol))} {
		if got := mode(t, p); got != PrivateDirMode {
			t.Errorf("%s is %v, want %v", p, got, PrivateDirMode)
		}
	}
	if got := mode(t, vol); got != VolumeDirMode {
		t.Errorf("volume folder is %v, want %v", got, VolumeDirMode)
	}

	// Folders an older agent made 0755.
	old := filepath.Join(l.ServicesDir(), "old")
	if err := os.MkdirAll(filepath.Join(old, "files"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{l.ServicesDir(), old} {
		if err := os.Chmod(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := l.MakeServiceDir("old"); err != nil {
		t.Fatal(err)
	}
	if mode(t, l.ServicesDir()) != PrivateDirMode || mode(t, old) != PrivateDirMode {
		t.Errorf("MakeServiceDir left %v and %v", mode(t, l.ServicesDir()), mode(t, old))
	}

	for _, p := range []string{l.ServicesDir(), old} {
		if err := os.Chmod(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(l.ServicesDir(), "stray"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := l.SecureServiceDirs(); err != nil {
		t.Fatal(err)
	}
	if mode(t, l.ServicesDir()) != PrivateDirMode || mode(t, old) != PrivateDirMode {
		t.Errorf("SecureServiceDirs left %v and %v", mode(t, l.ServicesDir()), mode(t, old))
	}
	if got := mode(t, filepath.Join(l.ServicesDir(), "stray")); got != 0o644 {
		t.Errorf("a file in services/ became %v", got)
	}
	if err := New(t.TempDir()).SecureServiceDirs(); err != nil {
		t.Errorf("no services folder: %v", err)
	}
	if _, err := l.MakeServiceDir("../x"); !errors.Is(err, ErrInvalidID) {
		t.Errorf("MakeServiceDir(../x) = %v", err)
	}
}
