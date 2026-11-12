package dbtools

import (
	"bytes"
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
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func parsePEM(t *testing.T, certPEM []byte) *x509.Certificate {
	t.Helper()
	b, _ := pem.Decode(certPEM)
	if b == nil {
		t.Fatal("no PEM block")
	}
	c, err := x509.ParseCertificate(b.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// strictSelfSigned is the test BoringSSL (Bun) and OpenSSL 1.1 make for a
// self-signed certificate: its own issuer, signed by its own key, and
// allowed to sign certificates (keyCertSign when key usage is set).
// crypto/x509's CheckSignatureFrom applies the same rules, plus basic
// constraints CA. OpenSSL 3 leaves the key usage out of it.
func strictSelfSigned(c *x509.Certificate) error {
	if !bytes.Equal(c.RawIssuer, c.RawSubject) {
		return errors.New("issuer is not the subject")
	}
	return c.CheckSignatureFrom(c)
}

// oldSelfSigned makes a fallback the way agents before 0.2.12 did: a leaf
// with digitalSignature only.
func oldSelfSigned(t *testing.T, host string) (certPEM, keyPEM []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(7),
		Subject:      pkix.Name{CommonName: host},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(10, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{host},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kder, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kder})
}

// The fallback is its own root, so every TLS library calls it a
// self-signed certificate and a client that trusts its file connects.
// The old one fails the strict self-signed check, which is why
// node-postgres on Bun (BoringSSL) said "unable to verify the first
// certificate" about it.
func TestSelfSignedIsItsOwnRoot(t *testing.T) {
	oldPEM, _ := oldSelfSigned(t, "db.example.com")
	if err := strictSelfSigned(parsePEM(t, oldPEM)); err == nil {
		t.Fatal("the old fallback passes the self-signed check")
	}
	if !oldFallback(oldPEM) {
		t.Fatal("the old fallback is not recognised")
	}

	for _, host := range []string{"db.example.com", ""} {
		certPEM, keyPEM, err := selfSigned(host)
		if err != nil {
			t.Fatal(err)
		}
		c := parsePEM(t, certPEM)
		if err := strictSelfSigned(c); err != nil {
			t.Fatalf("%q: not self-signed: %v", host, err)
		}
		if oldFallback(certPEM) {
			t.Fatalf("%q: counted as an old fallback", host)
		}
		if len(c.ExtKeyUsage) != 1 || c.ExtKeyUsage[0] != x509.ExtKeyUsageServerAuth || c.KeyUsage&x509.KeyUsageDigitalSignature == 0 {
			t.Fatalf("%q: usages %v %v", host, c.KeyUsage, c.ExtKeyUsage)
		}
		if !c.IsCA || !c.MaxPathLenZero || c.MaxPathLen != 0 {
			t.Fatalf("%q: CA %v, path length %d", host, c.IsCA, c.MaxPathLen)
		}
		// Untrusted it is refused; trusted by its own file it verifies.
		if _, err := c.Verify(x509.VerifyOptions{Roots: x509.NewCertPool()}); err == nil {
			t.Fatalf("%q: verified without being trusted", host)
		}
		roots := x509.NewCertPool()
		roots.AddCert(c)
		opts := x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
		if host != "" {
			opts.DNSName = host
			if c.DNSNames[0] != host || c.Subject.CommonName != host {
				t.Fatalf("names %v %q", c.DNSNames, c.Subject.CommonName)
			}
		}
		if _, err := c.Verify(opts); err != nil {
			t.Fatalf("%q: does not verify against itself: %v", host, err)
		}
		if host != "" {
			handshake(t, certPEM, keyPEM, roots, host)
		}
	}
}

// handshake connects a TLS client that trusts roots to a server with the
// certificate.
func handshake(t *testing.T, certPEM, keyPEM []byte, roots *x509.CertPool, host string) {
	t.Helper()
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	done := make(chan error, 1)
	go func() { done <- tls.Server(server, &tls.Config{Certificates: []tls.Certificate{pair}}).Handshake() }()
	if err := tls.Client(client, &tls.Config{RootCAs: roots, ServerName: host}).Handshake(); err != nil {
		t.Fatalf("client trusting the file: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// A fallback kept by an older agent is made again once, as its own root:
// the fingerprint changes, so ExposedTLS installs it on its next pass and
// the portgate serves it on the next handshake. Then it stays.
func TestCertForMakesAnOldFallbackAgainOnce(t *testing.T) {
	dir := t.TempDir()
	oldCert, oldKey := oldSelfSigned(t, "db.example.com")
	if err := os.WriteFile(filepath.Join(dir, "db1.crt"), oldCert, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "db1.key"), oldKey, 0o600); err != nil {
		t.Fatal(err)
	}
	x := NewExposedTLS(nil, nil, dir, t.TempDir(), nil)
	spec := dbSpec("db1", agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, false)
	spec.GetDatabase().Exposure = &agentv1.DatabaseExposure{Enabled: true, TlsHostname: "db.example.com"}
	// What an agent before 0.2.12 installed.
	x.applied["db1"] = tlsMaterial{certPEM: oldCert, keyPEM: oldKey, selfSigned: true}.fingerprint()

	m, err := x.material(spec)
	if err != nil {
		t.Fatal(err)
	}
	if !m.selfSigned || bytes.Equal(m.certPEM, oldCert) || oldFallback(m.certPEM) {
		t.Fatal("the old fallback was kept")
	}
	if err := strictSelfSigned(parsePEM(t, m.certPEM)); err != nil {
		t.Fatal(err)
	}
	if m.fingerprint() == x.applied["db1"] {
		t.Fatal("same fingerprint: the new certificate would not be installed")
	}
	if _, err := tls.X509KeyPair(m.certPEM, m.keyPEM); err != nil {
		t.Fatalf("key and certificate do not match: %v", err)
	}
	onDisk, _ := os.ReadFile(filepath.Join(dir, "db1.crt"))
	keyOnDisk, _ := os.ReadFile(filepath.Join(dir, "db1.key"))
	if !bytes.Equal(onDisk, m.certPEM) || !bytes.Equal(keyOnDisk, m.keyPEM) {
		t.Fatal("the new certificate is not kept")
	}
	if info, _ := os.Stat(filepath.Join(dir, "db1.key")); info.Mode().Perm() != 0o600 {
		t.Fatalf("key mode %v", info.Mode().Perm())
	}
	if _, err := os.Stat(filepath.Join(dir, "db1.crt.tmp")); !os.IsNotExist(err) {
		t.Fatalf("temporary file left: %v", err)
	}

	// Once: the new one stays, for the portgate too.
	again, kpem, err := Certificate(nil, dir, "db1", "db.example.com")
	if err != nil || !bytes.Equal(again, m.certPEM) || !bytes.Equal(kpem, m.keyPEM) {
		t.Fatalf("made again: %v", err)
	}
}
