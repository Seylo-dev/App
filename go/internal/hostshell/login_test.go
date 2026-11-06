package hostshell

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func writePasswd(t *testing.T, lines string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "passwd")
	if err := os.WriteFile(p, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoginForReadsThePasswdEntry(t *testing.T) {
	home := t.TempDir()
	p := writePasswd(t, "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n"+
		"admin:x:4242:4242:Admin:"+home+":/bin/sh\n")
	l, err := loginFor(p, 4242)
	if err != nil {
		t.Fatal(err)
	}
	if l.user != "admin" || l.home != home || l.shell != "/bin/sh" || l.argv0() != "-sh" {
		t.Fatalf("login = %+v", l)
	}
}

func TestLoginForFallsBack(t *testing.T) {
	// nologin shell and a missing home: bash or sh, and "/".
	p := writePasswd(t, "svc:x:4243:4243::/does/not/exist:/usr/sbin/nologin\n")
	l, err := loginFor(p, 4243)
	if err != nil {
		t.Fatal(err)
	}
	if l.user != "svc" || l.home != "/" || (l.shell != "/bin/bash" && l.shell != "/bin/sh") {
		t.Fatalf("login = %+v", l)
	}
	// No entry at all: root keeps its name and home when it exists.
	l, err = loginFor(filepath.Join(t.TempDir(), "missing"), 0)
	if err != nil {
		t.Fatal(err)
	}
	if l.user != "root" || (l.home != "/root" && l.home != "/") {
		t.Fatalf("root login = %+v", l)
	}
	if u, _ := loginFor(filepath.Join(t.TempDir(), "missing"), 4244); u.user != strconv.Itoa(4244) {
		t.Fatalf("unknown uid = %+v", u)
	}
}

func TestEnvironmentIsClean(t *testing.T) {
	t.Setenv("SEYLO_SECRET_FOR_TEST", "do-not-leak")
	l := login{user: "root", home: "/root", shell: "/bin/bash"}
	for _, kv := range l.env() {
		if kv == "SEYLO_SECRET_FOR_TEST=do-not-leak" {
			t.Fatal("the agent's environment leaked into the shell")
		}
	}
	if len(l.env()) != 7 {
		t.Fatalf("env = %v", l.env())
	}
}

func TestRefusedWhileOff(t *testing.T) {
	m := New(Options{Allowed: func() error { return ErrDisabled }})
	if _, err := m.Open(context.Background(), &agentv1.HostShellOpen{}); !errors.Is(err, ErrDisabled) {
		t.Fatalf("err = %v, want ErrDisabled", err)
	}
	if m.Count() != 0 {
		t.Fatal("a refused shell was counted")
	}
}
