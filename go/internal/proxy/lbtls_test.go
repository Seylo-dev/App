package proxy

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// testLBCA is a panel LB CA for tests.
type testLBCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  string
}

func newTestLBCA(t testing.TB) *testLBCA {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test LB CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return &testLBCA{cert: cert, key: key, pem: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))}
}

// issue returns a node's LoadBalancerTls signed by the CA.
func (ca *testLBCA) issue(t testing.TB, name string, usages ...x509.ExtKeyUsage) *agentv1.LoadBalancerTls {
	t.Helper()
	if len(usages) == 0 {
		usages = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), ExtKeyUsage: usages, KeyUsage: x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	kder, _ := x509.MarshalPKCS8PrivateKey(key)
	return &agentv1.LoadBalancerTls{
		CaPem:      ca.pem,
		CertPem:    string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		KeyPem:     string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kder})),
		ServerName: name,
	}
}

// lbNodeName is a node's own LB name in these tests.
func lbNodeName(nodeID string) string { return nodeID + ".lb.seylo.internal" }

// issueNode returns a node's LoadBalancerTls the way the panel issues it
// since 0.2: a one-off issuer the CA signed, then a certificate for the
// shared name and the node's own name, sent with the issuer. The second
// value is the issuer's PEM, for the peers list.
func (ca *testLBCA) issueNode(t testing.TB, nodeID string) (*agentv1.LoadBalancerTls, string) {
	t.Helper()
	ikey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	serial := big.NewInt(time.Now().UnixNano())
	itmpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "test LB issuer " + nodeID + " " + serial.String()},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, MaxPathLenZero: true, KeyUsage: x509.KeyUsageCertSign}
	ider, err := x509.CreateCertificate(rand.Reader, itmpl, ca.cert, &ikey.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	issuer, _ := x509.ParseCertificate(ider)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: lbNodeName(nodeID)},
		DNSNames:  []string{"lb.seylo.internal", lbNodeName(nodeID)},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, issuer, &key.PublicKey, ikey)
	if err != nil {
		t.Fatal(err)
	}
	kder, _ := x509.MarshalPKCS8PrivateKey(key)
	issuerPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ider}))
	return &agentv1.LoadBalancerTls{
		CaPem:          ca.pem,
		CertPem:        string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})) + issuerPEM,
		KeyPem:         string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kder})),
		ServerName:     "lb.seylo.internal",
		NodeServerName: lbNodeName(nodeID),
	}, issuerPEM
}

// withPeers returns a copy of lb listing peers.
func withPeers(lb *agentv1.LoadBalancerTls, peers ...*agentv1.LoadBalancerPeer) *agentv1.LoadBalancerTls {
	out := proto.Clone(lb).(*agentv1.LoadBalancerTls)
	out.Peers = peers
	return out
}

func peer(nodeID string, issuers ...string) *agentv1.LoadBalancerPeer {
	return &agentv1.LoadBalancerPeer{NodeId: nodeID, ServerName: lbNodeName(nodeID), IssuerPems: issuers}
}

// The configurations Traefik builds from our files, as Go TLS configs:
// the LB entry point's from LBTLSFile, a balancing node's from the
// serversTransport of the copy on a node.
func lbServerConfig(t *testing.T, lb *agentv1.LoadBalancerTls) *tls.Config {
	t.Helper()
	data, err := BuildLBTLS(lb)
	if err != nil {
		t.Fatal(err)
	}
	var cfg dynamicConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	c := cfg.TLS.Certificates[0]
	pair, err := tls.X509KeyPair([]byte(c.CertFile), []byte(c.KeyFile))
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	for _, ca := range cfg.TLS.Options[LBTLSOptions].ClientAuth.CAFiles {
		if !pool.AppendCertsFromPEM([]byte(ca)) {
			t.Fatalf("client CA that does not parse:\n%s", ca)
		}
	}
	return &tls.Config{Certificates: []tls.Certificate{pair}, ClientCAs: pool, ClientAuth: tls.RequireAndVerifyClientCert, MinVersion: tls.VersionTLS12}
}

func lbClientConfig(t *testing.T, lb *agentv1.LoadBalancerTls, nodeID string) *tls.Config {
	t.Helper()
	st, ok := lbTransport(lb, nodeID)
	if !ok {
		t.Fatalf("no transport to %s", nodeID)
	}
	roots := x509.NewCertPool()
	for _, ca := range st.RootCAs {
		roots.AppendCertsFromPEM([]byte(ca))
	}
	cfg := &tls.Config{ServerName: st.ServerName, RootCAs: roots, MinVersion: tls.VersionTLS12}
	for _, c := range st.Certificates {
		pair, err := tls.X509KeyPair([]byte(c.CertFile), []byte(c.KeyFile))
		if err != nil {
			t.Fatal(err)
		}
		cfg.Certificates = append(cfg.Certificates, pair)
	}
	return cfg
}

// lbHandshake connects client to server and returns the first error of
// either side, and the client certificate the server got.
func lbHandshake(server, client *tls.Config) (*x509.Certificate, error) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	type result struct {
		peer *x509.Certificate
		err  error
	}
	done := make(chan result, 1)
	go func() {
		s := tls.Server(a, server)
		err := s.Handshake()
		var got *x509.Certificate
		if certs := s.ConnectionState().PeerCertificates; len(certs) > 0 {
			got = certs[0]
		}
		if err != nil {
			_ = a.Close()
		}
		done <- result{got, err}
	}()
	c := tls.Client(b, client)
	cerr := c.Handshake()
	if cerr == nil {
		// TLS 1.3 servers check the client's certificate after the client
		// finished: read once so its alert reaches us.
		_ = c.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		var one [1]byte
		if _, err := c.Read(one[:]); err != nil && !errors.Is(err, os.ErrDeadlineExceeded) {
			cerr = err
		}
	}
	if cerr != nil {
		_ = b.Close()
	}
	res := <-done
	if res.err != nil {
		return nil, res.err
	}
	return res.peer, cerr
}

// Every node certificate names its node, and each node's LB entry point
// takes only the certificates of the nodes the panel lists: a removed
// node's (still valid under the CA) is refused, and a node that dials a
// sibling's copy refuses another node answering in its place.
func TestLBTLSAcceptsOnlyCurrentNodes(t *testing.T) {
	ca := newTestLBCA(t)
	a, ia := ca.issueNode(t, "a")
	b, ib := ca.issueNode(t, "b")
	c, ic := ca.issueNode(t, "c")
	removed, _ := ca.issueNode(t, "x")
	peers := []*agentv1.LoadBalancerPeer{peer("a", ia), peer("b", ib), peer("c", ic)}
	a, b, c = withPeers(a, peers...), withPeers(b, peers...), withPeers(c, peers...)
	removed = withPeers(removed, append(peers, peer("x"))...)

	bServer := lbServerConfig(t, b)
	if _, err := lbHandshake(bServer, lbClientConfig(t, a, "b")); err != nil {
		t.Fatalf("a current node was refused: %v", err)
	}
	if _, err := lbHandshake(bServer, lbClientConfig(t, c, "b")); err != nil {
		t.Fatalf("a current node was refused: %v", err)
	}
	// Before: any certificate of the CA opened every node's entry point.
	if _, err := lbHandshake(bServer, lbClientConfig(t, removed, "b")); err == nil {
		t.Fatal("a removed node's certificate was taken")
	}
	// Before: every certificate carried the one shared name, so c could
	// answer for b.
	if _, err := lbHandshake(lbServerConfig(t, c), lbClientConfig(t, a, "b")); err == nil {
		t.Fatal("c's certificate passed for b")
	}
	// An agent before 0.2 (shared name, no peers) still balances to an
	// upgraded node, and takes its certificate.
	old := proto.Clone(a).(*agentv1.LoadBalancerTls)
	old.Peers, old.NodeServerName = nil, ""
	if _, err := lbHandshake(bServer, lbClientConfig(t, old, "b")); err != nil {
		t.Fatalf("an older agent was refused: %v", err)
	}
	oldB := proto.Clone(b).(*agentv1.LoadBalancerTls)
	oldB.Peers, oldB.NodeServerName = nil, ""
	if _, err := lbHandshake(lbServerConfig(t, oldB), lbClientConfig(t, a, "b")); err != nil {
		t.Fatalf("an older agent's entry point refused an upgraded node: %v", err)
	}
	// From an older panel (no peers): any certificate of the CA, as before.
	if _, err := lbHandshake(lbServerConfig(t, oldB), lbClientConfig(t, removed, "b")); err != nil {
		t.Fatalf("no peers: %v", err)
	}
}

// A renewed node presents its new certificate to peers that know it and
// its previous one to peers that do not yet, so neither side has to hear
// of the renewal first; once nobody lists the old issuer it is refused.
func TestLBTLSRenewalOverlap(t *testing.T) {
	ca := newTestLBCA(t)
	oldA, ioldA := ca.issueNode(t, "a")
	newA, inewA := ca.issueNode(t, "a")
	b, ib := ca.issueNode(t, "b")
	renewed := proto.Clone(newA).(*agentv1.LoadBalancerTls)
	renewed.PreviousCertPem, renewed.PreviousKeyPem = oldA.GetCertPem(), oldA.GetKeyPem()
	renewed = withPeers(renewed, peer("a", inewA, ioldA), peer("b", ib))
	serial := func(lb *agentv1.LoadBalancerTls) string {
		return chainCerts(lb.GetCertPem())[0].SerialNumber.String()
	}
	for _, tc := range []struct {
		what    string
		issuers []string
		want    string
	}{
		{"b has not heard of the renewal", []string{ioldA}, serial(oldA)},
		{"b knows both", []string{inewA, ioldA}, serial(newA)},
		{"a confirmed the new one", []string{inewA}, serial(newA)},
	} {
		got, err := lbHandshake(lbServerConfig(t, withPeers(b, peer("a", tc.issuers...), peer("b", ib))), lbClientConfig(t, renewed, "b"))
		if err != nil {
			t.Fatalf("%s: %v", tc.what, err)
		}
		if got.SerialNumber.String() != tc.want {
			t.Errorf("%s: a presented %s, want %s", tc.what, got.SerialNumber, tc.want)
		}
	}
	// The old certificate alone, once b gave it up.
	if _, err := lbHandshake(lbServerConfig(t, withPeers(b, peer("a", inewA), peer("b", ib))), lbClientConfig(t, withPeers(oldA, peer("b", ib)), "b")); err == nil {
		t.Fatal("a replaced certificate was taken after its issuer was dropped")
	}
	// A broken previous certificate is left out rather than breaking the transport.
	broken := proto.Clone(renewed).(*agentv1.LoadBalancerTls)
	broken.PreviousKeyPem = b.GetKeyPem()
	if st, _ := lbTransport(broken, "b"); len(st.Certificates) != 1 {
		t.Fatalf("a previous certificate that does not match its key is presented: %d", len(st.Certificates))
	}
}

// While the panel lists a node that may still hold a certificate straight
// from the CA (from a panel before 0.2, not connected since), every
// certificate of the CA is taken, as before, so that node keeps working.
func TestLBTLSLegacyPeer(t *testing.T) {
	ca := newTestLBCA(t)
	b, ib := ca.issueNode(t, "b")
	legacy := ca.issue(t, "lb.seylo.internal")
	legacyPeer := &agentv1.LoadBalancerPeer{NodeId: "l", ServerName: "lb.seylo.internal", Legacy: true}
	server := lbServerConfig(t, withPeers(b, peer("b", ib), legacyPeer))
	if _, err := lbHandshake(server, lbClientConfig(t, legacy, "b")); err != nil {
		t.Fatalf("a legacy node was refused: %v", err)
	}
	// And the legacy node is dialed by the shared name.
	if name, ok := lbPeerName(withPeers(b, peer("b", ib), legacyPeer), "l"); !ok || name != "lb.seylo.internal" {
		t.Fatalf("legacy peer name %q %v", name, ok)
	}
	if _, err := lbHandshake(lbServerConfig(t, withPeers(b, peer("b", ib))), lbClientConfig(t, legacy, "b")); err == nil {
		t.Fatal("a legacy certificate was taken with no legacy peer listed")
	}
}

// What the panel lists as an issuer reaches the client CAs only when it is
// a CA certificate the LB CA signed; the LB CA itself, other certificates
// in the same text and certificates of another CA never do.
func TestLBClientCAsTakeOnlyIssuers(t *testing.T) {
	ca := newTestLBCA(t)
	b, ib := ca.issueNode(t, "b")
	_, iother := newTestLBCA(t).issueNode(t, "o")
	removed, _ := ca.issueNode(t, "x")
	leaf := chainCerts(removed.GetCertPem())[0]
	leafPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leaf.Raw}))
	lb := withPeers(b, peer("b", ib),
		peer("p1", ib+ca.pem), // the CA appended to a real issuer
		peer("p2", ca.pem),    // the CA itself
		peer("p3", iother),    // another CA's issuer
		peer("p4", leafPEM),   // a node certificate, not a CA
		peer("p5", "garbage"), // not PEM
	)
	cas := lbClientCAs(lb)
	if len(cas) != 1 || cas[0] != ib {
		t.Fatalf("client CAs %q, want only b's issuer", cas)
	}
	server := lbServerConfig(t, lb)
	if _, err := lbHandshake(server, lbClientConfig(t, withPeers(removed, peer("b", ib)), "b")); err == nil {
		t.Fatal("a certificate of the CA was taken through a smuggled CA")
	}
}

func TestBuildLBTLS(t *testing.T) {
	ca := newTestLBCA(t)
	lb := ca.issue(t, "lb.seylo.internal")
	data, err := BuildLBTLS(lb)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{
		"clientAuthType: RequireAndVerifyClientCert",
		"options: " + LBTLSOptions,
		"rule: Host(`lb.seylo.internal`)",
		"- " + EntryPointLB,
		"minVersion: VersionTLS12",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("LB TLS file lacks %q:\n%s", want, text)
		}
	}

	other := newTestLBCA(t)
	bad := map[string]*agentv1.LoadBalancerTls{
		"another CA": func() *agentv1.LoadBalancerTls { c := other.issue(t, "lb.seylo.internal"); c.CaPem = ca.pem; return c }(),
		"wrong server name": func() *agentv1.LoadBalancerTls {
			c := ca.issue(t, "lb.seylo.internal")
			c.ServerName = "other.internal"
			return c
		}(),
		"no client auth": ca.issue(t, "lb.seylo.internal", x509.ExtKeyUsageServerAuth),
		"key mismatch": func() *agentv1.LoadBalancerTls {
			c := ca.issue(t, "lb.seylo.internal")
			c.KeyPem = ca.issue(t, "x.internal").KeyPem
			return c
		}(),
		"rule injection": func() *agentv1.LoadBalancerTls {
			c := ca.issue(t, "lb.seylo.internal")
			c.ServerName = "a`) || Host(`b"
			return c
		}(),
	}
	for name, lb := range bad {
		if _, err := BuildLBTLS(lb); !errors.Is(err, ErrBadLBTLS) {
			t.Errorf("%s: %v, want ErrBadLBTLS", name, err)
		}
	}
}

func TestFileRouterWritesLBTLS(t *testing.T) {
	dir := t.TempDir()
	r := NewFileRouter(FileConfig{Dir: dir, LBEntryPoint: true})
	ca := newTestLBCA(t)
	settings := &agentv1.NodeSettings{LbTls: ca.issue(t, "lb.seylo.internal")}
	r.SetSettings(settings)
	spec := app("svc1", route("r1", "a.example.com"))
	spec.LoadBalancer = &agentv1.LoadBalancer{RemoteUpstreams: []*agentv1.RemoteUpstream{{NodeId: "n2", Url: "https://198.51.100.2:5757"}}}
	if err := r.Apply(t.Context(), spec, ups("http://seylo-svc1-1:3000")); err != nil {
		t.Fatal(err)
	}
	tlsFile := filepath.Join(dir, LBTLSFile)
	if _, err := os.Stat(tlsFile); err != nil {
		t.Fatalf("no LB TLS file: %v", err)
	}
	route, _ := os.ReadFile(filepath.Join(dir, "seylo-svc1.yml"))
	if !strings.Contains(string(route), "options: "+LBTLSOptions) || strings.Contains(string(route), "insecureSkipVerify") {
		t.Fatalf("route file without mutual TLS:\n%s", route)
	}
	// Prune never takes it for a service's file.
	if removed, err := r.Prune(nil); err != nil || len(removed) != 0 {
		t.Fatalf("prune removed %v (%v)", removed, err)
	}
	// Gone when the panel stops sending it, and the routers go back.
	r.SetSettings(&agentv1.NodeSettings{})
	if _, err := os.Stat(tlsFile); !os.IsNotExist(err) {
		t.Fatalf("LB TLS file kept: %v", err)
	}
	route, _ = os.ReadFile(filepath.Join(dir, "seylo-svc1.yml"))
	if strings.Contains(string(route), "options: "+LBTLSOptions) {
		t.Fatalf("routers still name the LB TLS options:\n%s", route)
	}
	// An unusable lb_tls keeps the routers on the options without the
	// file: refused, never open.
	broken := ca.issue(t, "lb.seylo.internal")
	broken.CaPem = newTestLBCA(t).pem
	r.SetSettings(&agentv1.NodeSettings{LbTls: broken})
	if _, err := os.Stat(tlsFile); !os.IsNotExist(err) {
		t.Fatal("an unusable LB TLS file was written")
	}
	route, _ = os.ReadFile(filepath.Join(dir, "seylo-svc1.yml"))
	if !strings.Contains(string(route), "options: "+LBTLSOptions) {
		t.Fatal("an unusable lb_tls opened the LB routers to everyone")
	}
}

// Next to Wings the LB entry point is our LB Traefik: the file goes to its
// folder, never into the fork's.
func TestFileRouterLBTLSNextToWings(t *testing.T) {
	dir, lbDir := t.TempDir(), t.TempDir()
	r := NewFileRouter(FileConfig{Dir: dir, LBDir: lbDir})
	r.SetSettings(&agentv1.NodeSettings{LbTls: newTestLBCA(t).issue(t, "lb.seylo.internal")})
	if _, err := os.Stat(filepath.Join(lbDir, LBTLSFile)); err != nil {
		t.Fatalf("not in the LB Traefik's folder: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, LBTLSFile)); !os.IsNotExist(err) {
		t.Fatal("written into the Wings fork's folder")
	}
	// Removed by hand (or a pruner): Reassert puts it back.
	_ = os.Remove(filepath.Join(lbDir, LBTLSFile))
	if n, err := r.Reassert(); err != nil || n != 1 {
		t.Fatalf("reassert: %d %v", n, err)
	}
}
