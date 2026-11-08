package tailnet

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/seylo-dev/app/go/internal/tailnet/tailnettest"
)

const (
	testTarget = "unix:/var/lib/seylo/panel/tailnet.sock"
	testName   = "panel.tail1234.ts.net"
)

func testWant() Want { return Want{DNSName: testName, HTTPS: true, Target: testTarget} }

// top decodes a Serve config's top level.
func top(t *testing.T, raw []byte) map[string]json.RawMessage {
	t.Helper()
	m := map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, raw)
	}
	return m
}

func field(t *testing.T, raw json.RawMessage) map[string]json.RawMessage {
	t.Helper()
	return top(t, raw)
}

func ensure(t *testing.T, raw []byte, w Want) Change {
	t.Helper()
	ch, err := Ensure(raw, w)
	if err != nil {
		t.Fatal(err)
	}
	return ch
}

func entries(t *testing.T, raw []byte) []ServeEntry {
	t.Helper()
	found, err := Find(raw, testTarget)
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func TestEnsureKeepsUnknownFieldsByteForByte(t *testing.T) {
	owner := bytes.TrimSpace(tailnettest.Fixture(t, "serve-owner"))
	ch := ensure(t, owner, testWant())
	if ch.Config == nil || ch.Conflict != "" {
		t.Fatalf("Ensure = %+v", ch)
	}
	before, after := top(t, owner), top(t, ch.Config)
	for _, key := range []string{"Services", "Foreground", "AllowFunnel", "FutureTopKey"} {
		if !bytes.Equal(before[key], after[key]) {
			t.Errorf("%s changed:\n%s\n%s", key, before[key], after[key])
		}
	}
	tcpBefore, tcpAfter := field(t, before["TCP"]), field(t, after["TCP"])
	for _, port := range []string{"5432", "8080"} {
		if !bytes.Equal(tcpBefore[port], tcpAfter[port]) {
			t.Errorf("TCP %s changed: %s -> %s", port, tcpBefore[port], tcpAfter[port])
		}
	}
	if string(tcpAfter["443"]) != `{"HTTPS":true}` {
		t.Errorf("TCP 443 = %s", tcpAfter["443"])
	}
	webBefore, webAfter := field(t, before["Web"]), field(t, after["Web"])
	if hp := testName + ":8080"; !bytes.Equal(webBefore[hp], webAfter[hp]) {
		t.Errorf("the owner's web entry changed:\n%s\n%s", webBefore[hp], webAfter[hp])
	}
	if !strings.Contains(string(ch.Config), `"owner <b>&</b>"`) {
		t.Errorf("HTML in the owner's text was escaped: %s", ch.Config)
	}
	if got := string(webAfter[testName+":443"]); got != `{"Handlers":{"/":{"Proxy":"`+testTarget+`"}}}` {
		t.Errorf("our entry = %s", got)
	}
	want := ServeEntry{HostPort: testName + ":443", Path: "/", Proxy: testTarget}
	if ch.Entry == nil || *ch.Entry != want {
		t.Errorf("Entry = %+v", ch.Entry)
	}
	if got := entries(t, ch.Config); !slices.Equal(got, []ServeEntry{want}) {
		t.Errorf("Find = %+v", got)
	}
}

func TestEnsureIsANoOpWhenTheEntryIsThere(t *testing.T) {
	for _, start := range []string{"null", "", "{}", string(bytes.TrimSpace(tailnettest.Fixture(t, "serve-owner")))} {
		first := ensure(t, []byte(start), testWant())
		if first.Config == nil {
			t.Fatalf("Ensure(%q) wrote nothing", start)
		}
		again := ensure(t, first.Config, testWant())
		if again.Config != nil || again.Conflict != "" || again.Entry == nil {
			t.Fatalf("second Ensure on %q = %+v", start, again)
		}
	}
}

func TestEnsureConflicts(t *testing.T) {
	hp := testName + ":443"
	ours := `{"Proxy":"` + testTarget + `"}`
	for _, tc := range []struct {
		name, config, says string
		keepsOurs          bool
	}{
		{"another handler on /", `{"TCP":{"443":{"HTTPS":true}},"Web":{"` + hp + `":{"Handlers":{"/":{"Text":"mine"}}}}}`, "another handler on " + hp + " (path /)", false},
		{"another path next to ours", `{"TCP":{"443":{"HTTPS":true}},"Web":{"` + hp + `":{"Handlers":{"/":` + ours + `,"/x":{"Text":"mine"}}}}}`, "(path /x)", true},
		{"a TCP forward on 443", `{"TCP":{"443":{"TCPForward":"127.0.0.1:8443"}}}`, "port 443 for a TCP forward to 127.0.0.1:8443", false},
		{"plain HTTP on 443", `{"TCP":{"443":{"HTTP":true}}}`, "port 443 for plain HTTP", false},
		{"a foreground serve", `{"Foreground":{"s1":{"TCP":{"443":{"HTTPS":true}},"Web":{"` + hp + `":{"Handlers":{"/":{"Text":"fg"}}}}}}}`, "foreground", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ch := ensure(t, []byte(tc.config), testWant())
			if !strings.Contains(ch.Conflict, tc.says) {
				t.Fatalf("Conflict = %q, want it to say %q", ch.Conflict, tc.says)
			}
			if ch.Config != nil {
				t.Fatalf("a conflict wrote %s", ch.Config)
			}
			if (ch.Entry != nil) != tc.keepsOurs {
				t.Fatalf("Entry = %+v, keepsOurs %v", ch.Entry, tc.keepsOurs)
			}
		})
	}
}

func TestEnsureRefusesFunnel(t *testing.T) {
	hp := testName + ":443"
	with := ensure(t, []byte("null"), testWant()).Config
	m := top(t, with)
	m["AllowFunnel"] = json.RawMessage(`{"` + hp + `":true}`)
	funneled, _ := json.Marshal(m)

	ch := ensure(t, funneled, testWant())
	if !strings.Contains(ch.Conflict, "Funnel is on for "+hp) {
		t.Fatalf("Conflict = %q", ch.Conflict)
	}
	if ch.Config == nil || ch.Entry != nil {
		t.Fatalf("the entry stayed under Funnel: %+v", ch)
	}
	after := top(t, ch.Config)
	if _, ok := after["Web"]; ok {
		t.Errorf("Web left: %s", ch.Config)
	}
	if _, ok := after["TCP"]; ok {
		t.Errorf("TCP 443 left: %s", ch.Config)
	}
	if string(after["AllowFunnel"]) != `{"`+hp+`":true}` {
		t.Errorf("the owner's AllowFunnel changed: %s", after["AllowFunnel"])
	}
	if strings.Contains(string(ch.Config), "AllowFunnel\":{}") || strings.Count(string(ch.Config), "true") != 1 {
		t.Errorf("Ensure wrote AllowFunnel: %s", ch.Config)
	}
	// Without our entry: nothing to write, still a conflict.
	again := ensure(t, ch.Config, testWant())
	if again.Conflict == "" || again.Config != nil {
		t.Fatalf("second pass = %+v", again)
	}
	// A foreground session's Funnel counts too.
	fg := `{"Foreground":{"s1":{"AllowFunnel":{"` + hp + `":true}}}}`
	if ch := ensure(t, []byte(fg), testWant()); !strings.Contains(ch.Conflict, "Funnel") || ch.Config != nil {
		t.Fatalf("foreground Funnel = %+v", ch)
	}
}

func TestRemoveKeepsTheOwnersEntries(t *testing.T) {
	owner := bytes.TrimSpace(tailnettest.Fixture(t, "serve-owner"))
	with := ensure(t, owner, testWant()).Config
	ch, err := Remove(with, testTarget)
	if err != nil {
		t.Fatal(err)
	}
	if ch.Config == nil {
		t.Fatal("Remove wrote nothing")
	}
	before, after := top(t, owner), top(t, ch.Config)
	if len(before) != len(after) {
		t.Fatalf("keys %d -> %d: %s", len(before), len(after), ch.Config)
	}
	for key, raw := range before {
		if key == "TCP" || key == "Web" {
			var a, b any
			_ = json.Unmarshal(raw, &a)
			_ = json.Unmarshal(after[key], &b)
			ja, _ := json.Marshal(a)
			jb, _ := json.Marshal(b)
			if !bytes.Equal(ja, jb) {
				t.Errorf("%s:\n%s\n%s", key, raw, after[key])
			}
			continue
		}
		if !bytes.Equal(raw, after[key]) {
			t.Errorf("%s changed: %s -> %s", key, raw, after[key])
		}
	}
	if got := entries(t, ch.Config); len(got) != 0 {
		t.Errorf("our entry is still there: %+v", got)
	}
	// Nothing of ours: no write.
	if again, _ := Remove(ch.Config, testTarget); again.Config != nil {
		t.Errorf("a second Remove wrote %s", again.Config)
	}
	if none, _ := Remove([]byte("null"), testTarget); none.Config != nil {
		t.Errorf("Remove on null wrote %s", none.Config)
	}
}

// The TCP port stays while another host uses it, and an owner's TCP
// forward is never removed.
func TestRemoveKeepsAPortSomethingElseUses(t *testing.T) {
	cfg := `{"TCP":{"443":{"HTTPS":true}},"Web":{"` + testName + `:443":{"Handlers":{"/":{"Proxy":"` + testTarget + `"},"/x":{"Text":"mine"}}}}}`
	ch, err := Remove([]byte(cfg), testTarget)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(ch.Config); got != `{"TCP":{"443":{"HTTPS":true}},"Web":{"`+testName+`:443":{"Handlers":{"/x":{"Text":"mine"}}}}}` {
		t.Fatalf("Remove = %s", got)
	}
}

func TestEnsureFollowsADNSRename(t *testing.T) {
	old := ensure(t, bytes.TrimSpace(tailnettest.Fixture(t, "serve-owner")), testWant()).Config
	w := testWant()
	w.DNSName = "seylo.tail1234.ts.net"
	ch := ensure(t, old, w)
	if ch.Config == nil || ch.Conflict != "" {
		t.Fatalf("Ensure = %+v", ch)
	}
	if got := entries(t, ch.Config); !slices.Equal(got, []ServeEntry{{HostPort: "seylo.tail1234.ts.net:443", Path: "/", Proxy: testTarget}}) {
		t.Fatalf("entries = %+v", got)
	}
	if tcp := field(t, top(t, ch.Config)["TCP"]); string(tcp["443"]) != `{"HTTPS":true}` {
		t.Fatalf("TCP 443 = %s", tcp["443"])
	}
}

func TestEnsureHTTPAndHTTPS(t *testing.T) {
	w := testWant()
	w.HTTPS = false
	plain := ensure(t, []byte("null"), w)
	if got := string(plain.Config); got != `{"TCP":{"80":{"HTTP":true}},"Web":{"`+testName+`:80":{"Handlers":{"/":{"Proxy":"`+testTarget+`"}}}}}` {
		t.Fatalf("HTTP mode = %s", got)
	}
	if w.URL() != "http://"+testName || testWant().URL() != "https://"+testName {
		t.Fatalf("URLs %s %s", w.URL(), testWant().URL())
	}
	// The tailnet turned HTTPS on: the entry moves to 443 and port 80 goes.
	secure := ensure(t, plain.Config, testWant())
	if got := string(secure.Config); got != `{"TCP":{"443":{"HTTPS":true}},"Web":{"`+testName+`:443":{"Handlers":{"/":{"Proxy":"`+testTarget+`"}}}}}` {
		t.Fatalf("HTTPS mode = %s", got)
	}
	// And back.
	if back := ensure(t, secure.Config, w); string(back.Config) != string(plain.Config) {
		t.Fatalf("back to HTTP = %s", back.Config)
	}
}

// A handler on the socket's unresolved path is ours too and is replaced.
func TestEnsureReplacesAnAlias(t *testing.T) {
	alias := "unix:/data/link/panel/tailnet.sock"
	cfg := `{"TCP":{"443":{"HTTPS":true}},"Web":{"` + testName + `:443":{"Handlers":{"/":{"Proxy":"` + alias + `"}}}}}`
	w := testWant()
	w.Aliases = []string{alias}
	ch := ensure(t, []byte(cfg), w)
	if ch.Conflict != "" || !strings.Contains(string(ch.Config), testTarget) || strings.Contains(string(ch.Config), alias) {
		t.Fatalf("Ensure = %+v %s", ch, ch.Config)
	}
	// Without the alias it is somebody else's handler.
	if ch := ensure(t, []byte(cfg), testWant()); ch.Conflict == "" {
		t.Fatal("an unknown proxy on / is not a conflict")
	}
}

func TestServeConfigErrors(t *testing.T) {
	if _, err := Ensure([]byte("{"), testWant()); err == nil || !strings.Contains(err.Error(), "Serve config") {
		t.Fatalf("bad JSON = %v", err)
	}
	if _, err := Ensure([]byte(`{"Web":{"x:443":{"Handlers":[]}}}`), testWant()); err == nil {
		t.Fatal("Handlers as a list was accepted")
	}
	if _, err := Ensure([]byte("null"), Want{Target: testTarget}); err == nil {
		t.Fatal("Ensure without a DNS name")
	}
}

func TestTargetsResolveSymlinks(t *testing.T) {
	real := t.TempDir()
	if err := os.MkdirAll(filepath.Join(real, "panel"), 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "data")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(real)
	if err != nil {
		t.Fatal(err)
	}
	socket := PanelSocket(link)
	if socket != filepath.Join(link, "panel", "tailnet.sock") {
		t.Fatalf("PanelSocket = %s", socket)
	}
	target, ours := Targets(socket)
	if want := "unix:" + filepath.Join(resolved, "panel", "tailnet.sock"); target != want {
		t.Fatalf("target = %s, want %s", target, want)
	}
	if !slices.Equal(ours, []string{target, "unix:" + socket}) {
		t.Fatalf("ours = %v", ours)
	}
	// A folder that does not exist yet: the plain path.
	if target, ours := Targets("/nonexistent/panel/tailnet.sock"); target != "unix:/nonexistent/panel/tailnet.sock" || len(ours) != 1 {
		t.Fatalf("Targets = %s %v", target, ours)
	}
}
