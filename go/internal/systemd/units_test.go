package systemd

import (
	"bytes"
	"context"
	"errors"
	"io"
	"slices"
	"strings"
	"testing"
)

type call struct {
	name string
	args []string
}

func recordingUnits(output string, err error) (*Units, *[]call) {
	var calls []call
	return &Units{run: func(_ context.Context, stdout io.Writer, name string, args ...string) error {
		calls = append(calls, call{name, args})
		_, _ = io.WriteString(stdout, output)
		return err
	}}, &calls
}

func TestCommands(t *testing.T) {
	u, calls := recordingUnits("", nil)
	ctx := context.Background()
	_ = u.Start(ctx, AgentUnit)
	_ = u.Restart(ctx, AgentUnit)
	_ = u.Logs(ctx, AgentUnit, LogsOptions{Lines: 50, Follow: true}, io.Discard)

	want := []call{
		{"systemctl", []string{"start", "seylo.service"}},
		{"systemctl", []string{"restart", "seylo.service"}},
		{"journalctl", []string{"--unit", "seylo.service", "--no-pager", "--output", "short-iso", "--lines", "50", "--follow"}},
	}
	if len(*calls) != len(want) {
		t.Fatalf("calls = %v", *calls)
	}
	for i, c := range *calls {
		if c.name != want[i].name || !slices.Equal(c.args, want[i].args) {
			t.Errorf("call %d = %v, want %v", i, c, want[i])
		}
	}
}

func TestStatus(t *testing.T) {
	u, _ := recordingUnits("active\n", nil)
	state, err := u.Status(context.Background(), AgentUnit)
	if err != nil || state != "active" {
		t.Fatalf("Status = %q, %v", state, err)
	}

	u, _ = recordingUnits("", nil)
	if _, err := u.Status(context.Background(), AgentUnit); err == nil {
		t.Fatal("empty output must be an error")
	}

	boom := errors.New("exit status 1")
	u, _ = recordingUnits("", boom)
	if _, err := u.Status(context.Background(), AgentUnit); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
}

func TestExecRunnerReportsStderr(t *testing.T) {
	var out bytes.Buffer
	err := ExecRunner(context.Background(), &out, "sh", "-c", "echo out; echo bad >&2; exit 3")
	if err == nil || !strings.Contains(err.Error(), "bad") {
		t.Fatalf("err = %v, want stderr in the message", err)
	}
	if out.String() != "out\n" {
		t.Fatalf("stdout = %q", out.String())
	}
}

func TestUnitFiles(t *testing.T) {
	unit := AgentUnitFile("/usr/local/bin/seylo", "/var/lib/seylo")
	for _, want := range []string{"ExecStart=/usr/local/bin/seylo agent --data-dir /var/lib/seylo", "Restart=always", "Requires=docker.service", "WantedBy=multi-user.target"} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit misses %q:\n%s", want, unit)
		}
	}
	if strings.Contains(unit, "Slice=") {
		t.Error("the agent must not run inside the services' slice")
	}
	if !strings.Contains(SliceUnitFile(), "CPUWeight=100") {
		t.Error("slice has no CPU weight")
	}

	dir := t.TempDir()
	var reloads int
	run := func(_ context.Context, _ io.Writer, name string, args ...string) error {
		if name == "systemctl" && args[0] == "daemon-reload" {
			reloads++
		}
		return nil
	}
	changed, err := InstallUnits(context.Background(), dir, "/usr/local/bin/seylo", "/var/lib/seylo", run)
	if err != nil || !changed || reloads != 1 {
		t.Fatalf("first install: changed=%v reloads=%d err=%v", changed, reloads, err)
	}
	changed, err = InstallUnits(context.Background(), dir, "/usr/local/bin/seylo", "/var/lib/seylo", run)
	if err != nil || changed || reloads != 1 {
		t.Fatalf("second install must be a no-op: changed=%v reloads=%d err=%v", changed, reloads, err)
	}
	if err := RemoveUnits(dir); err != nil {
		t.Fatal(err)
	}
	if err := RemoveUnits(dir); err != nil {
		t.Fatalf("removing twice: %v", err)
	}
}

func TestJournal(t *testing.T) {
	out := `{"__REALTIME_TIMESTAMP":"1762345678000000","MESSAGE":"time=2026-11-05T12:00:00Z level=WARN msg=\"panel unreachable\"","PRIORITY":"6"}
{"__REALTIME_TIMESTAMP":"1762345679000000","MESSAGE":"plain line","PRIORITY":"3"}
{"__REALTIME_TIMESTAMP":"1762345680000000","MESSAGE":[104,105],"PRIORITY":"6"}
not json
`
	u, calls := recordingUnits(out, nil)
	entries, err := u.Journal(context.Background(), AgentUnit, JournalOptions{Tail: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 || entries[0].Level != "warn" || entries[1].Level != "error" || entries[2].Message != "hi" || entries[2].Level != "info" {
		t.Fatalf("entries = %+v", entries)
	}
	if entries[0].Time.Unix() != 1762345678 {
		t.Fatalf("time = %v", entries[0].Time)
	}
	if !slices.Contains((*calls)[0].args, "20") {
		t.Fatalf("args = %v", (*calls)[0].args)
	}
}
