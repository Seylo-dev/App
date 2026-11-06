//go:build linux

package agent

import (
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// hostShellOutput reads a HostShell stream until want shows up or the
// shell exits; it returns the output and the exit code (-1 when none).
func hostShellOutput(t *testing.T, st rpc.Stream, want string) (string, int32) {
	t.Helper()
	var out strings.Builder
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var msg agentv1.HostShellResponse
		if err := st.Recv(&msg); err != nil {
			if errors.Is(err, io.EOF) {
				return out.String(), -1
			}
			t.Fatalf("recv: %v (output so far %q)", err, out.String())
		}
		switch m := msg.GetMessage().(type) {
		case *agentv1.HostShellResponse_Output:
			out.Write(m.Output)
			if want != "" && strings.Contains(out.String(), want) {
				return out.String(), -1
			}
		case *agentv1.HostShellResponse_ExitCode:
			return out.String(), m.ExitCode
		}
	}
	t.Fatalf("timed out; output %q", out.String())
	return "", -1
}

func TestHostShellRunsHostnameAndExits(t *testing.T) {
	d, _ := newTestDeps(t)
	setHostShell(d, true)
	panel := hostShellPeer(t, d)
	st := openHostShell(t, panel)
	var first agentv1.HostShellResponse
	if err := st.Recv(&first); err != nil {
		t.Fatal(err)
	}
	host, _ := os.Hostname()
	info := first.GetInfo()
	if info.GetHostname() != host || info.GetIdleTimeoutSeconds() != 900 || !strings.HasPrefix(info.GetCommand()[0], "-") {
		t.Fatalf("first message = %v", &first)
	}
	if err := st.Send(&agentv1.HostShellRequest{Message: &agentv1.HostShellRequest_Input{Input: []byte("hostname; exit 0\n")}}); err != nil {
		t.Fatal(err)
	}
	out, code := hostShellOutput(t, st, "")
	if code != 0 || !strings.Contains(out, host) {
		t.Fatalf("exit %d, output %q (want the hostname %q)", code, out, host)
	}
	if err := st.Finish(nil); err != nil {
		t.Fatal(err)
	}
}

// Turning the setting off hangs up the shells that are open.
func TestHostShellClosesWhenTheSettingTurnsOff(t *testing.T) {
	d, _ := newTestDeps(t)
	setHostShell(d, true)
	panel := hostShellPeer(t, d)
	st := openHostShell(t, panel)
	if err := st.Recv(&agentv1.HostShellResponse{}); err != nil {
		t.Fatal(err)
	}
	if err := st.Send(&agentv1.HostShellRequest{Message: &agentv1.HostShellRequest_Input{Input: []byte("echo ready-$((40+2))\n")}}); err != nil {
		t.Fatal(err)
	}
	hostShellOutput(t, st, "ready-42")
	setHostShell(d, false)
	out, code := hostShellOutput(t, st, "")
	if code < 128 || !strings.Contains(out, "host shells were turned off") {
		t.Fatalf("exit %d, output %q", code, out)
	}
	_ = st.Finish(nil)
	st = openHostShell(t, panel)
	if s := rpc.StatusOf(st.Recv(&agentv1.HostShellResponse{})); s.GetCode() != agentv1.StatusCode_STATUS_CODE_PERMISSION_DENIED {
		t.Fatalf("after turning off: %v", s)
	}
}
