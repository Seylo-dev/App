package agent

import (
	"context"
	"slices"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// Until the tailnet area is built, its methods answer UNIMPLEMENTED and its
// capabilities stay unadvertised, so a 0.2.1 panel leaves the agent alone.
func TestTailnetNotAdvertisedUntilBuilt(t *testing.T) {
	d, _ := newTestDeps(t)
	reg, err := Wire(d)
	if err != nil {
		t.Fatal(err)
	}
	caps := d.Facts.Get().GetCapabilities()
	for _, name := range []string{"tailnet.login.v1", "tailnet.serve.v1"} {
		if slices.Contains(caps, name) {
			t.Fatalf("%s advertised before the tailnet area is built: %v", name, caps)
		}
	}
	panel := rpctest.NewPeer(t, reg)
	err = panel.Call(context.Background(), "TailscaleLogin", &agentv1.TailscaleLoginRequest{}, &agentv1.TailscaleLoginResponse{})
	if s := rpc.StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_UNIMPLEMENTED {
		t.Fatalf("TailscaleLogin = %v, want UNIMPLEMENTED", s)
	}
	err = panel.Call(context.Background(), "TailscaleSetDns", &agentv1.TailscaleSetDnsRequest{}, &agentv1.TailscaleSetDnsResponse{})
	if s := rpc.StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_UNIMPLEMENTED {
		t.Fatalf("TailscaleSetDns = %v, want UNIMPLEMENTED", s)
	}
}
