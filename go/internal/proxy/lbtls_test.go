package proxy

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
