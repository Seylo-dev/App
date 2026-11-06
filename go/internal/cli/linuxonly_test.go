package cli

import (
	"bytes"
	"runtime"
	"strings"
	"testing"
)

func TestNodeCommandsOffLinux(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("node commands run on Linux")
	}
	for _, args := range [][]string{{"agent"}, {"status"}, {"panel", "logs"}, {"join", "http://x", "--token", "t"}} {
		root := newRootCommand(&deps{})
		var out bytes.Buffer
		root.SetOut(&out)
		root.SetErr(&out)
		root.SetArgs(args)
		err := root.Execute()
		if err == nil || !strings.Contains(err.Error(), "runs on a Linux server") || !strings.Contains(err.Error(), args[0]) {
			t.Errorf("%v: %v", args, err)
		}
	}
}

// `logs <project/service>` is a laptop command: off Linux it goes to the
// panel (here: fails for want of a login), only bare `logs` is refused.
func TestLogsWithAServiceRunsOffLinux(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("node commands run on Linux")
	}
	root := newRootCommand(&deps{})
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs([]string{"logs", "proj/svc"})
	if err := root.Execute(); err != nil && strings.Contains(err.Error(), "runs on a Linux server") {
		t.Fatalf("logs proj/svc refused off Linux: %v", err)
	}
	root = newRootCommand(&deps{})
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs([]string{"logs"})
	if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "runs on a Linux server") {
		t.Fatalf("bare logs off Linux: %v", err)
	}
}
