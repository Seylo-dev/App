package agent

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// oldDomain is where the test nodes joined: the panel's domain, which
// their network no longer lets through.
const oldDomain = "https://panel.example.com"

// domainNode writes the data dir of a node that joined panel over its
// domain (no pin) and recorded its identity, with a setting of its owner
// and a key this agent does not know, and registers the node with panel.
func domainNode(t *testing.T, panel *rpctest.FakePanel, proves bool) (datadir.Layout, []byte) {
	t.Helper()
	layout := shortLayout(t)
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(priv)
	if err := os.WriteFile(layout.AgentKey(), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	panel.AddNode("node7", pub)
	raw := "# kept by hand\npanel_url: " + oldDomain + "\nnode_id: node7\n" +
		"panel_id: " + panel.PanelID + "\npanel_key: " + base64.StdEncoding.EncodeToString(panel.EdgeKey) + "\n" +
		"no_host_shell: true\nfuture_key: keep me\n"
	if proves {
		raw += "panel_proves: true\n"
	}
	if err := os.WriteFile(layout.ConfigFile(), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	return layout, []byte(raw)
}

func setPanelAt(t *testing.T, layout datadir.Layout, opts SetPanelOptions) (*SetPanelResult, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return SetPanel(ctx, layout, opts)
}

// untouched fails unless config.yml is still before and no backup was made.
func untouched(t *testing.T, layout datadir.Layout, before []byte) {
	t.Helper()
	if after, _ := os.ReadFile(layout.ConfigFile()); !bytes.Equal(after, before) {
		t.Fatalf("config.yml changed:\n%s", after)
	}
	if _, err := os.Stat(layout.ConfigFile() + ".bak"); err == nil {
		t.Fatal("a backup was written for a change that did not happen")
	}
}

// A node that joined over the domain is pointed at the panel's IP and
// pin: the address is checked as this node's panel first, then config.yml
// gets the new address, keeps the node, its identity and its owner's
// settings, and the file as it was is the backup.
func TestSetPanelKeepsTheNode(t *testing.T) {
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	panel.SignAccepts(true)
	layout, before := domainNode(t, panel, true)
	pin := conn.FormatPin(panel.SPKI())

	res, err := setPanelAt(t, layout, SetPanelOptions{PanelURL: panel.URL(), Pin: pin})
	if err != nil {
		t.Fatal(err)
	}
	if res.PanelID != panel.PanelID || res.Previous != oldDomain || res.Refused != nil || res.Unchanged {
		t.Fatalf("result = %+v", res)
	}
	cfg := loadCfg(t, layout)
	if cfg.PanelURL != panel.URL() || cfg.PanelPin != pin || cfg.NodeID != "node7" ||
		cfg.PanelID != panel.PanelID || cfg.PanelKey == "" || !cfg.PanelProves || !cfg.NoHostShell {
		t.Fatalf("config.yml = %+v", cfg)
	}
	// As a move does: the old address is the fallback for one cycle.
	if cfg.Fallback == nil || cfg.Fallback.PanelURL != oldDomain || cfg.Fallback.PanelPin != "" || cfg.Fallback.Standing {
		t.Fatalf("fallback = %+v", cfg.Fallback)
	}
	written, _ := os.ReadFile(layout.ConfigFile())
	if !strings.Contains(string(written), "future_key: keep me") || !strings.Contains(string(written), "# kept by hand") {
		t.Fatalf("config.yml lost what the owner wrote:\n%s", written)
	}
	backup, err := os.ReadFile(res.Backup)
	if err != nil || !bytes.Equal(backup, before) || res.Backup != layout.ConfigFile()+".bak" {
		t.Fatalf("backup %s = %q, %v", res.Backup, backup, err)
	}
	if st, _ := os.Stat(res.Backup); st.Mode().Perm() != 0o600 {
		t.Fatalf("backup mode %v", st.Mode())
	}
	hellos := panel.Hellos()
	if len(hellos) != 1 || hellos[0].GetResume().GetNodeId() != "node7" {
		t.Fatalf("hellos = %v", hellos)
	}
	// The check's session is closed again: the agent's own comes after the restart.
	panel.WaitDisconnected("node7")
}

// Without --pin the certificate must come from a trusted CA, like a
// domain's; the pin stays empty then.
func TestSetPanelWithoutPinUsesTheRoots(t *testing.T) {
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	layout, before := domainNode(t, panel, false)

	_, err := setPanelAt(t, layout, SetPanelOptions{PanelURL: panel.URL(), RootCAs: x509.NewCertPool()})
	var unknown x509.UnknownAuthorityError
	if !errors.As(err, &unknown) || !strings.Contains(err.Error(), "could not connect to "+panel.URL()) {
		t.Fatalf("err = %v", err)
	}
	untouched(t, layout, before)

	if _, err := setPanelAt(t, layout, SetPanelOptions{PanelURL: panel.URL(), RootCAs: trusting(panel.Server)}); err != nil {
		t.Fatal(err)
	}
	if cfg := loadCfg(t, layout); cfg.PanelURL != panel.URL() || cfg.PanelPin != "" {
		t.Fatalf("config.yml = %+v", cfg)
	}
}

// Another panel at that address, however much of this panel's identity it
// copied, changes nothing: the same checks as every connect.
func TestSetPanelRefusesAnotherPanel(t *testing.T) {
	for _, c := range []struct {
		name  string
		setup func(real, other *rpctest.FakePanel)
		hello bool
		want  string
	}{
		{"another panel id", func(_, o *rpctest.FakePanel) { o.PanelID = "other" }, false, "answers as another panel"},
		{"copied panel id, own key", func(r, o *rpctest.FakePanel) { o.PanelID = r.PanelID }, true, "another panel identity key"},
		{"copied id and public key, no signature", func(r, o *rpctest.FakePanel) {
			o.PanelID, o.EdgeKey = r.PanelID, r.EdgeKey
		}, true, "did not prove the panel's identity"},
		{"copied id and public key, signed with its own key", func(r, o *rpctest.FakePanel) {
			o.PanelID, o.EdgeKey = r.PanelID, r.EdgeKey
			o.SignAccepts(true)
		}, true, "signature does not match"},
	} {
		t.Run(c.name, func(t *testing.T) {
			real := rpctest.NewFakePanel(t, rpctest.WithTLS())
			layout, before := domainNode(t, real, true)
			other := rpctest.NewFakePanel(t, rpctest.WithTLS())
			c.setup(real, other)
			other.AddNode("node7", mustKey(t, layout).Public().(ed25519.PublicKey))

			_, err := setPanelAt(t, layout, SetPanelOptions{PanelURL: other.URL(), Pin: conn.FormatPin(other.SPKI())})
			if !errors.Is(err, errOtherPanel) || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want %q", err, c.want)
			}
			untouched(t, layout, before)
			if got := len(other.Hellos()) > 0; got != c.hello {
				t.Fatalf("the other panel got a ClientHello: %v, want %v", got, c.hello)
			}
		})
	}
}

func mustKey(t *testing.T, layout datadir.Layout) ed25519.PrivateKey {
	t.Helper()
	key, err := readAgentKey(layout.AgentKey())
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// A pin the address does not present is refused before any hello.
func TestSetPanelWrongPin(t *testing.T) {
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	layout, before := domainNode(t, panel, false)
	_, err := setPanelAt(t, layout, SetPanelOptions{PanelURL: panel.URL(), Pin: conn.FormatPin(make([]byte, 32))})
	if !errors.Is(err, conn.ErrPinMismatch) || !strings.Contains(err.Error(), "did not present the key --pin names") {
		t.Fatalf("err = %v", err)
	}
	untouched(t, layout, before)
	if len(panel.Hellos()) != 0 {
		t.Fatal("a hello went to an address with another key")
	}
}

func TestSetPanelNoConnection(t *testing.T) {
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	layout, before := domainNode(t, panel, false)
	gone := rpctest.NewFakePanel(t, rpctest.WithTLS())
	url, pin := gone.URL(), conn.FormatPin(gone.SPKI())
	gone.Server.Close()
	_, err := setPanelAt(t, layout, SetPanelOptions{PanelURL: url, Pin: pin})
	if err == nil || !strings.Contains(err.Error(), "could not connect to "+url) {
		t.Fatalf("err = %v", err)
	}
	untouched(t, layout, before)
}

// holdSession connects as the node and keeps the session, like the agent
// connected through another address.
func holdSession(t *testing.T, panel *rpctest.FakePanel, key ed25519.PrivateKey) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	wsURL, _ := AgentURL(panel.URL())
	ws, err := conn.Dial(ctx, conn.DialOptions{URL: wsURL, PinSHA256: panel.SPKI()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws.Close("done") })
	if _, err := rpc.AgentHandshake(ctx, ws, func(s *agentv1.ServerHello) (*agentv1.ClientHello, error) {
		return &agentv1.ClientHello{Credential: &agentv1.ClientHello_Resume{Resume: &agentv1.ResumeCredential{
			NodeId: "node7", Signature: rpc.SignHello(key, s, "node7"),
		}}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	panel.WaitConnected("node7")
}

// The agent is connected right now: the panel refuses a second session.
// Signed with this panel's key, that refusal proves the address; unsigned
// from a panel that signs, it proves nothing.
func TestSetPanelWhileTheAgentIsConnected(t *testing.T) {
	t.Run("signed", func(t *testing.T) {
		panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
		panel.SignAccepts(true)
		layout, _ := domainNode(t, panel, true)
		holdSession(t, panel, mustKey(t, layout))
		res, err := setPanelAt(t, layout, SetPanelOptions{PanelURL: panel.URL(), Pin: conn.FormatPin(panel.SPKI())})
		if err != nil {
			t.Fatal(err)
		}
		if res.Refused.GetReason() != agentv1.HelloRejectReason_HELLO_REJECT_REASON_ALREADY_CONNECTED {
			t.Fatalf("refused = %v", res.Refused)
		}
		if cfg := loadCfg(t, layout); cfg.PanelURL != panel.URL() {
			t.Fatalf("panel_url = %s", cfg.PanelURL)
		}
	})
	t.Run("unsigned", func(t *testing.T) {
		panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
		layout, before := domainNode(t, panel, true)
		holdSession(t, panel, mustKey(t, layout))
		_, err := setPanelAt(t, layout, SetPanelOptions{PanelURL: panel.URL(), Pin: conn.FormatPin(panel.SPKI())})
		if err == nil || !strings.Contains(err.Error(), "not proven to be the panel this node belongs to") ||
			!strings.Contains(err.Error(), "stop it (sudo systemctl stop seylo.service)") {
			t.Fatalf("err = %v", err)
		}
		untouched(t, layout, before)
	})
}

// A panel that no longer knows the node (removed under Nodes) is no place
// to point it: join again instead.
func TestSetPanelRemovedNode(t *testing.T) {
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	panel.SignAccepts(true)
	layout, before := domainNode(t, panel, true)
	other := rpctest.NewFakePanel(t, rpctest.WithTLS())
	other.PanelID, other.EdgeKey, other.EdgePrivate = panel.PanelID, panel.EdgeKey, panel.EdgePrivate
	other.SignAccepts(true)
	_, err := setPanelAt(t, layout, SetPanelOptions{PanelURL: other.URL(), Pin: conn.FormatPin(other.SPKI())})
	if err == nil || !strings.Contains(err.Error(), "refused this node: unknown node (HELLO_REJECT_REASON_UNKNOWN_NODE)") {
		t.Fatalf("err = %v", err)
	}
	untouched(t, layout, before)
}

// The address and pin it already has: nothing to dial or write.
func TestSetPanelSameAddress(t *testing.T) {
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	layout, _ := domainNode(t, panel, false)
	pin := conn.FormatPin(panel.SPKI())
	if _, err := setPanelAt(t, layout, SetPanelOptions{PanelURL: panel.URL(), Pin: pin}); err != nil {
		t.Fatal(err)
	}
	connects := panel.Connects()
	before, _ := os.ReadFile(layout.ConfigFile())
	if err := os.Remove(layout.ConfigFile() + ".bak"); err != nil {
		t.Fatal(err)
	}
	// The same address written another way, and the pin in capitals.
	res, err := setPanelAt(t, layout, SetPanelOptions{PanelURL: panel.URL() + "/", Pin: strings.ToUpper(pin)})
	if err != nil || !res.Unchanged {
		t.Fatalf("res = %+v, err = %v", res, err)
	}
	if panel.Connects() != connects {
		t.Fatal("an unchanged address was dialed")
	}
	untouched(t, layout, before)
}

func TestSetPanelTarget(t *testing.T) {
	pin := "sha256:" + strings.Repeat("ab", 32)
	for _, c := range []struct {
		opts     SetPanelOptions
		want     string
		insecure bool
	}{
		{SetPanelOptions{PanelURL: "https://203.0.113.5:3443", Pin: pin}, "", false},
		{SetPanelOptions{PanelURL: "https://panel.example.com"}, "", false},
		{SetPanelOptions{PanelURL: "http://203.0.113.5:3000"}, "plain HTTP to the panel", false},
		{SetPanelOptions{PanelURL: "http://203.0.113.5:3000", Insecure: true}, "", true},
		{SetPanelOptions{PanelURL: "http://127.0.0.1:3000"}, "", false},
		{SetPanelOptions{PanelURL: "http://203.0.113.5:3000", Pin: pin, Insecure: true}, "--pin needs an https:// panel URL", false},
		{SetPanelOptions{PanelURL: "https://203.0.113.5:3443", Pin: "sha256:12"}, "--pin:", false},
		{SetPanelOptions{PanelURL: "203.0.113.5:3443"}, "is not a URL", false},
		{SetPanelOptions{PanelURL: "ftp://203.0.113.5"}, "must start with https://", false},
	} {
		got, err := setPanelTarget(c.opts)
		switch {
		case c.want == "" && err != nil:
			t.Errorf("%+v: %v", c.opts, err)
		case c.want != "" && (err == nil || !strings.Contains(err.Error(), c.want)):
			t.Errorf("%+v: err = %v, want %q", c.opts, err, c.want)
		case err == nil && got.insecure != c.insecure:
			t.Errorf("%+v: insecure = %v", c.opts, got.insecure)
		}
	}
}

// A node that never finished joining has no node to keep.
func TestSetPanelBeforeTheJoin(t *testing.T) {
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	layout := shortLayout(t)
	if err := Join(layout, JoinOptions{PanelURL: oldDomain, Token: "tok"}); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(layout.ConfigFile())
	_, err := setPanelAt(t, layout, SetPanelOptions{PanelURL: panel.URL(), Pin: conn.FormatPin(panel.SPKI())})
	if err == nil || !strings.Contains(err.Error(), "has not finished joining") {
		t.Fatalf("err = %v", err)
	}
	untouched(t, layout, before)
}
