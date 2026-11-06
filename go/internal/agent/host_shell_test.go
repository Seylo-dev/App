package agent

import (
	"context"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// hostShellPeer registers HostShell on a fresh mux, as the panel sees it.
func hostShellPeer(t *testing.T, d *Deps) *rpctest.Peer {
	t.Helper()
	reg := rpc.NewAgentMux()
	registerHostShell(reg, d)
	return rpctest.NewPeer(t, reg)
}

func setHostShell(d *Deps, on bool) {
	rev := d.Feed.Current().GetRevision() + 1
	d.Feed.Publish(&agentv1.DesiredState{Revision: rev, Settings: &agentv1.NodeSettings{HostShell: on}})
}

func openHostShell(t *testing.T, panel *rpctest.Peer) rpc.Stream {
	t.Helper()
	open := &agentv1.HostShellOpen{Size: &agentv1.TerminalSize{Columns: 80, Rows: 24}, OpenedBy: "owner <owner@example.com>", SessionId: "hs1"}
	st, err := panel.Open(context.Background(), "HostShell", &agentv1.HostShellRequest{Message: &agentv1.HostShellRequest_Open{Open: open}})
	if err != nil {
		t.Fatal(err)
	}
	return st
}

// The agent itself refuses a host shell while the node setting is off, so
// a panel that skipped its own checks still gets nothing.
func TestHostShellRefusedWhileTheSettingIsOff(t *testing.T) {
	d, _ := newTestDeps(t)
	panel := hostShellPeer(t, d)
	st := openHostShell(t, panel)
	err := st.Recv(&agentv1.HostShellResponse{})
	s := rpc.StatusOf(err)
	if s.GetCode() != agentv1.StatusCode_STATUS_CODE_PERMISSION_DENIED || !strings.Contains(s.GetMessage(), "not allowed host shells") {
		t.Fatalf("status = %v", s)
	}
}

func TestHostShellRefusedByConfig(t *testing.T) {
	d, _ := newTestDeps(t)
	d.Config.NoHostShell = true
	setHostShell(d, true)
	panel := hostShellPeer(t, d)
	st := openHostShell(t, panel)
	s := rpc.StatusOf(st.Recv(&agentv1.HostShellResponse{}))
	if s.GetCode() != agentv1.StatusCode_STATUS_CODE_PERMISSION_DENIED || !strings.Contains(s.GetMessage(), "no_host_shell") {
		t.Fatalf("status = %v", s)
	}
}

func TestHostShellFirstMessageMustBeOpen(t *testing.T) {
	d, _ := newTestDeps(t)
	setHostShell(d, true)
	panel := hostShellPeer(t, d)
	st, err := panel.Open(context.Background(), "HostShell", &agentv1.HostShellRequest{Message: &agentv1.HostShellRequest_Input{Input: []byte("id\n")}})
	if err != nil {
		t.Fatal(err)
	}
	if s := rpc.StatusOf(st.Recv(&agentv1.HostShellResponse{})); s.GetCode() != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT {
		t.Fatalf("status = %v", s)
	}
}
