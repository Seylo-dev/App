package dbtools

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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
// allowed to sign certificates (keyCertSign when key usage is set). Basic
// constraints do not count. OpenSSL 3 leaves the key usage out of it.
func strictSelfSigned(c *x509.Certificate) error {
	if !bytes.Equal(c.RawIssuer, c.RawSubject) {
		return errors.New("issuer is not the subject")
	}
	if err := c.CheckSignature(c.SignatureAlgorithm, c.RawTBSCertificate, c.Signature); err != nil {
		return err
	}
	if c.KeyUsage != 0 && c.KeyUsage&x509.KeyUsageCertSign == 0 {
		return errors.New("key usage without keyCertSign")
	}
	return nil
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

// The fallback is a self-signed certificate to the strict check, not a CA
// (rustls refuses a CA served as the server's own), and name-constrained
// to its host name (or to nothing real without one) and no IP address, so
// a trusted copy cannot vouch for a certificate made with its key for any
// other name. The old one fails the strict check, which is why
// node-postgres on Bun (BoringSSL) said "unable to verify the first
// certificate" about it.
func TestSelfSignedFallback(t *testing.T) {
	oldPEM, _ := oldSelfSigned(t, "db.example.com")
	if err := strictSelfSigned(parsePEM(t, oldPEM)); err == nil {
		t.Fatal("the old fallback passes the self-signed check")
	}
	if !staleFallback(oldPEM, "db.example.com") || !staleFallback(oldPEM, "") {
		t.Fatal("the old fallback is not recognised")
	}

	for host, permitted := range map[string]string{"db.example.com": "db.example.com", "": "invalid"} {
		certPEM, keyPEM, err := selfSigned(host)
		if err != nil {
			t.Fatal(err)
		}
		c := parsePEM(t, certPEM)
		if err := strictSelfSigned(c); err != nil {
			t.Fatalf("%q: not self-signed: %v", host, err)
		}
		if staleFallback(certPEM, host) {
			t.Fatalf("%q: counted as stale", host)
		}
		if len(c.ExtKeyUsage) != 1 || c.ExtKeyUsage[0] != x509.ExtKeyUsageServerAuth || c.KeyUsage&x509.KeyUsageDigitalSignature == 0 {
			t.Fatalf("%q: usages %v %v", host, c.KeyUsage, c.ExtKeyUsage)
		}
		if c.IsCA || !c.BasicConstraintsValid {
			t.Fatalf("%q: CA %v (basic constraints %v)", host, c.IsCA, c.BasicConstraintsValid)
		}
		if !c.PermittedDNSDomainsCritical || !slices.Equal(c.PermittedDNSDomains, []string{permitted}) ||
			len(c.ExcludedDNSDomains) != 0 || len(c.PermittedIPRanges) != 0 {
			t.Fatalf("%q: DNS name constraints %v (critical %v), excluded %v, IPs %v", host,
				c.PermittedDNSDomains, c.PermittedDNSDomainsCritical, c.ExcludedDNSDomains, c.PermittedIPRanges)
		}
		var excluded []string
		for _, n := range c.ExcludedIPRanges {
			excluded = append(excluded, n.String())
		}
		if !slices.Equal(excluded, []string{"0.0.0.0/0", "::/0"}) {
			t.Fatalf("%q: excluded IP ranges %v", host, excluded)
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
			if !slices.Equal(c.DNSNames, []string{host}) || c.Subject.CommonName != host {
				t.Fatalf("names %v %q", c.DNSNames, c.Subject.CommonName)
			}
		} else if len(c.DNSNames) != 0 || c.Subject.CommonName != "database" {
			t.Fatalf("no host: names %v %q", c.DNSNames, c.Subject.CommonName)
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

// A fallback kept by an older agent is made again once: the fingerprint
// changes, so ExposedTLS installs it on its next pass and
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
	if !m.selfSigned || bytes.Equal(m.certPEM, oldCert) || staleFallback(m.certPEM, "db.example.com") {
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

// fallbackLike makes a self-signed certificate from the template mutate
// leaves, for kept fallbacks of other kinds.
func fallbackLike(t *testing.T, mutate func(*x509.Certificate)) (certPEM, keyPEM []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(9), Subject: pkix.Name{CommonName: "database"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(10, 0, 0),
		KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true, PermittedDNSDomainsCritical: true, PermittedDNSDomains: []string{"invalid"},
	}
	mutate(tmpl)
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

// A kept fallback is made again when it is not of the current kind (CA,
// no name constraints, not a certificate) or does not name the TLS host
// name it is asked for, so a client that trusts the downloaded file and
// checks the name connects; one that fits stays, and without a host name
// any current one stays.
func TestCertForMakesAStaleFallbackAgain(t *testing.T) {
	named := func(host string) func(*x509.Certificate) {
		return func(c *x509.Certificate) {
			c.Subject.CommonName, c.DNSNames, c.PermittedDNSDomains = host, []string{host}, []string{host}
		}
	}
	cases := []struct {
		name, host string
		cert       func(t *testing.T) ([]byte, []byte)
		again      bool
	}{
		{"CA (0.2.12 drafts)", "", func(t *testing.T) ([]byte, []byte) {
			return fallbackLike(t, func(c *x509.Certificate) {
				c.IsCA, c.MaxPathLenZero, c.PermittedDNSDomains, c.PermittedDNSDomainsCritical = true, true, nil, false
			})
		}, true},
		{"no name constraints", "", func(t *testing.T) ([]byte, []byte) {
			return fallbackLike(t, func(c *x509.Certificate) { c.PermittedDNSDomains, c.PermittedDNSDomainsCritical = nil, false })
		}, true},
		{"not a certificate", "", func(t *testing.T) ([]byte, []byte) {
			_, k := fallbackLike(t, func(*x509.Certificate) {})
			return []byte("garbage"), k
		}, true},
		{"made without a host name, asked for one", "db.example.com", func(t *testing.T) ([]byte, []byte) {
			return fallbackLike(t, func(*x509.Certificate) {})
		}, true},
		{"made for another host name", "db.example.com", func(t *testing.T) ([]byte, []byte) {
			return fallbackLike(t, named("old.example.com"))
		}, true},
		{"fits the host name", "db.example.com", func(t *testing.T) ([]byte, []byte) {
			return fallbackLike(t, named("db.example.com"))
		}, false},
		{"no host name", "", func(t *testing.T) ([]byte, []byte) {
			return fallbackLike(t, func(*x509.Certificate) {})
		}, false},
		{"no host name, made for one", "", func(t *testing.T) ([]byte, []byte) {
			return fallbackLike(t, named("db.example.com"))
		}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			keptCert, keptKey := c.cert(t)
			if err := os.WriteFile(filepath.Join(dir, "db1.crt"), keptCert, 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "db1.key"), keptKey, 0o600); err != nil {
				t.Fatal(err)
			}
			certPEM, keyPEM, err := Certificate(nil, dir, "db1", c.host)
			if err != nil {
				t.Fatal(err)
			}
			if !c.again {
				if !bytes.Equal(certPEM, keptCert) || !bytes.Equal(keyPEM, keptKey) {
					t.Fatal("made again")
				}
				return
			}
			if bytes.Equal(certPEM, keptCert) || bytes.Equal(keyPEM, keptKey) {
				t.Fatal("kept")
			}
			if staleFallback(certPEM, c.host) {
				t.Fatal("made again as a stale one")
			}
			if c.host != "" && !slices.Equal(parsePEM(t, certPEM).DNSNames, []string{c.host}) {
				t.Fatalf("names %v", parsePEM(t, certPEM).DNSNames)
			}
			// Once.
			again, _, err := Certificate(nil, dir, "db1", c.host)
			if err != nil || !bytes.Equal(again, certPEM) {
				t.Fatalf("made again twice: %v", err)
			}
		})
	}
}

// signedWith makes a server certificate for dns or ip signed with the key
// of the fallback parentPEM: what someone who read a database's key could
// make.
func signedWith(t *testing.T, parentPEM, parentKeyPEM []byte, dns string, ip net.IP) (certPEM, keyPEM []byte) {
	t.Helper()
	pair, err := tls.X509KeyPair(parentPEM, parentKeyPEM)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(11), Subject: pkix.Name{CommonName: "impostor"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(1, 0, 0),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	if dns != "" {
		tmpl.DNSNames = []string{dns}
	}
	if ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parsePEM(t, parentPEM), &key.PublicKey, pair.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	kder, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kder})
}

// tlsServer serves certPEM on a local port until the test ends.
func tlsServer(t *testing.T, certPEM, keyPEM []byte) int {
	t.Helper()
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{pair}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_ = c.(*tls.Conn).Handshake()
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// bunTLS is a node:tls client run by Bun, whose TLS is BoringSSL: each
// case connects and reports "OK" or the error code.
const bunTLS = `import tls from "node:tls";
import { readFileSync } from "node:fs";
const out = {};
for (const c of JSON.parse(process.argv[2])) {
  out[c.name] = await new Promise((resolve) => {
    const opts = { host: "127.0.0.1", port: c.port };
    if (c.servername) opts.servername = c.servername;
    if (c.ca) opts.ca = readFileSync(c.ca);
    if (!c.checkName) opts.checkServerIdentity = () => undefined;
    const s = tls.connect(opts, () => { s.destroy(); resolve("OK"); });
    s.on("error", (e) => resolve(e.code || e.message));
    setTimeout(() => resolve("TIMEOUT"), 10000);
  });
}
console.log(JSON.stringify(out));
process.exit(0);
`

// The fallback as node-postgres on Bun sees it (BoringSSL, the client the
// case came from; skipped without bun): the old one was "unable to verify
// the first certificate", the new one is a "self-signed certificate" that
// connects once the client trusts its file (by name with a host name, by
// the certificate alone without one), and that trusted file does not
// vouch for a certificate made with its key for another name or an IP
// address. BoringSSL does not look at a trust anchor's basic constraints,
// so only the name constraints stop those.
func TestFallbackWithBun(t *testing.T) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("no bun on this host")
	}
	dir := t.TempDir()
	file := func(name string, data []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, data, 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	const host = "db.example.com"
	oldCert, oldKey := oldSelfSigned(t, host)
	newCert, newKey, err := selfSigned(host)
	if err != nil {
		t.Fatal(err)
	}
	noHostCert, noHostKey, err := selfSigned("")
	if err != nil {
		t.Fatal(err)
	}
	newCA, noHostCA := file("new.crt", newCert), file("nohost.crt", noHostCert)
	other, otherKey := signedWith(t, newCert, newKey, "evil.example.org", nil)
	ip, ipKey := signedWith(t, newCert, newKey, "", net.ParseIP("127.0.0.1"))
	noHostOther, noHostOtherKey := signedWith(t, noHostCert, noHostKey, "evil.example.org", nil)

	type tc struct {
		Name       string `json:"name"`
		Port       int    `json:"port"`
		CA         string `json:"ca,omitempty"`
		ServerName string `json:"servername,omitempty"`
		CheckName  bool   `json:"checkName"`
	}
	newPort, noHostPort := tlsServer(t, newCert, newKey), tlsServer(t, noHostCert, noHostKey)
	cases := []tc{
		{"old, not trusted", tlsServer(t, oldCert, oldKey), "", host, true},
		{"new, not trusted", newPort, "", host, true},
		{"new, trusted", newPort, newCA, host, true},
		{"no host name, trusted, name not checked", noHostPort, noHostCA, "", false},
		{"no host name, trusted, name checked", noHostPort, noHostCA, "", true},
		{"another name with its key, trusted", tlsServer(t, other, otherKey), newCA, "evil.example.org", true},
		{"an IP address with its key, trusted", tlsServer(t, ip, ipKey), newCA, "", true},
		{"another name with the no-host key, trusted, name not checked", tlsServer(t, noHostOther, noHostOtherKey), noHostCA, "", false},
	}
	want := map[string]string{
		"old, not trusted": "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
		"new, not trusted": "DEPTH_ZERO_SELF_SIGNED_CERT",
		"new, trusted":     "OK",
		"no host name, trusted, name not checked": "OK",
		"no host name, trusted, name checked":     "ERR_TLS_CERT_ALTNAME_INVALID",
	}
	arg, err := json.Marshal(cases)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, bun, file("client.mjs", []byte(bunTLS)), string(arg))
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("bun: %v %s", err, out)
	}
	var got map[string]string
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("bun said %s: %v", out, err)
	}
	for _, c := range cases {
		if w, ok := want[c.Name]; ok {
			if got[c.Name] != w {
				t.Errorf("%s: %q, want %q", c.Name, got[c.Name], w)
			}
		} else if got[c.Name] == "OK" || got[c.Name] == "" {
			t.Errorf("%s: %q, want refused", c.Name, got[c.Name])
		}
	}
}
