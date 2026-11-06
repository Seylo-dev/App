package datadir

import (
	"errors"
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
