//go:build integration

package dbtools_test

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dbtools"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

// The self-signed fallback as an OpenSSL client sees it: `openssl s_client
// -starttls postgres|mysql` against Postgres and MySQL with the agent's
// TLS. A fallback an older agent kept (a leaf without keyCertSign, which
// Bun's BoringSSL and OpenSSL 1.1 refuse as "unable to verify the first
// certificate"; the VM's OpenSSL 3 already calls it self-signed) is made
// again and installed: the database then serves the new one (CA:FALSE,
// keyCertSign, name-constrained), which -verify_return_error reports as
// "self-signed certificate" and which verifies with its own file as the
// CA (libpq verify-ca, mysql --ssl-ca). Once the exposure gets a TLS host
// name without an ACME certificate, the fallback is made again for that
// name and verifies with the name checked too (libpq verify-full).
func TestExposedTLSFallbackIsSelfSignedForOpenSSL(t *testing.T) {
	openssl, err := exec.LookPath("openssl")
	if err != nil {
		t.Skip("no openssl on this host")
	}
	e := itest.New(t)
	const admin = "admin-pw"
	const self = `"$(awk 'END{print $1}' /etc/hosts)"`
	cases := map[string]struct {
		engine   agentv1.DatabaseEngine
		image    string
		user     string
		env      []*agentv1.EnvVar
		ready    []string
		port     string
		starttls string
	}{
		"postgres": {agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, "postgres:17-alpine", "admin",
			[]*agentv1.EnvVar{{Name: "POSTGRES_USER", Value: "admin"}, {Name: "POSTGRES_PASSWORD", Value: admin}, {Name: "POSTGRES_DB", Value: "app"}},
			[]string{"sh", "-c", `PGPASSWORD=` + admin + ` psql --host=` + self + ` -U admin -d app -tA -c 'select 1'`},
			"5432", "postgres"},
		"mysql": {agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, "mysql:8.4", "root",
			[]*agentv1.EnvVar{{Name: "MYSQL_ROOT_PASSWORD", Value: admin}, {Name: "MYSQL_DATABASE", Value: "app"}},
			[]string{"sh", "-c", `MYSQL_PWD=` + admin + ` mysql --host=` + self + ` -uroot -N -e 'select 1'`},
			"3306", "mysql"},
	}
	var images []string
	for _, c := range cases {
		images = append(images, c.image)
	}
	e.Pull(images...)
	t.Run("engines", func(t *testing.T) {
		for name, c := range cases {
			t.Run(name, func(t *testing.T) {
				t.Parallel()
				e := e.With(t)
				s := e.Spec("tls"+name, "tls-"+name, c.image)
				s.Kind = agentv1.ServiceKind_SERVICE_KIND_DATABASE
				s.Env = c.env
				s.KindSpec = &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: c.engine,
					Credentials: &agentv1.DatabaseCredentials{AdminUser: c.user, AdminPassword: admin, Database: "app"},
					Exposure:    &agentv1.DatabaseExposure{Enabled: true}}}
				cont := e.StartService(s)
				e.Eventually(name+" accepting logins", 4*time.Minute, func() bool {
					_, code := e.Exec(cont.Name, c.ready, nil)
					return code == 0
				})
				addr := net.JoinHostPort(cont.IPs[e.Network].String(), c.port)
				sClient := func(extra ...string) string {
					ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
					defer cancel()
					args := append([]string{"s_client", "-starttls", c.starttls, "-connect", addr}, extra...)
					out, _ := exec.CommandContext(ctx, openssl, args...).CombinedOutput()
					return string(out)
				}
				// served is the certificate the database presents.
				served := func() *x509.Certificate {
					t.Helper()
					out := sClient()
					b, _ := pem.Decode([]byte(out[max(0, bytes.Index([]byte(out), []byte("-----BEGIN CERTIFICATE-----"))):]))
					if b == nil {
						t.Fatalf("no certificate in: %s", out)
					}
					cert, err := x509.ParseCertificate(b.Bytes)
					if err != nil {
						t.Fatal(err)
					}
					return cert
				}
				dir := t.TempDir()
				oldCert, oldKey := oldFallback(t)
				oldBlock, _ := pem.Decode(oldCert)

				// What an older agent installed (through the ACME source
				// here, which installs what it is given).
				old := dbtools.NewExposedTLS(e.D, func(string) ([]byte, []byte, error) { return oldCert, oldKey, nil }, t.TempDir(), t.TempDir(), nil)
				if err := old.Apply(e.Ctx(time.Minute), withHostname(s, "old.example.com")); err != nil {
					t.Fatalf("installing the old certificate: %v", err)
				}
				if got := served(); !bytes.Equal(got.Raw, oldBlock.Bytes) || got.KeyUsage&x509.KeyUsageCertSign != 0 {
					t.Fatal("the database does not serve the old fallback")
				}

				// This agent finds it kept, makes it again and installs that.
				if err := os.WriteFile(filepath.Join(dir, s.GetId()+".crt"), oldCert, 0o644); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, s.GetId()+".key"), oldKey, 0o600); err != nil {
					t.Fatal(err)
				}
				x := dbtools.NewExposedTLS(e.D, nil, dir, t.TempDir(), nil)
				if err := x.Apply(e.Ctx(time.Minute), s); err != nil {
					t.Fatalf("installing the fallback: %v", err)
				}
				ca := filepath.Join(dir, s.GetId()+".crt")
				kept, _ := os.ReadFile(ca)
				keptBlock, _ := pem.Decode(kept)
				if keptBlock == nil || bytes.Equal(kept, oldCert) {
					t.Fatal("the old fallback is still kept")
				}
				got := served()
				if !bytes.Equal(got.Raw, keptBlock.Bytes) || got.IsCA || got.KeyUsage&x509.KeyUsageCertSign == 0 ||
					!got.PermittedDNSDomainsCritical || len(got.PermittedDNSDomains) == 0 {
					t.Fatal("the database does not serve the new fallback")
				}
				if out := sClient("-verify_return_error"); !regexp.MustCompile(`verify error:num=18:self[- ]signed certificate`).MatchString(out) {
					t.Fatalf("the new fallback, without a CA: %s", out)
				}
				if out := sClient("-verify_return_error", "-CAfile", ca); !regexp.MustCompile(`Verify return code: 0 \(ok\)`).MatchString(out) {
					t.Fatalf("the new fallback with itself as the CA: %s", out)
				}

				// A TLS host name with no ACME certificate for it: made again
				// for that name, which a client that checks it accepts.
				const host = "db.seylo.test"
				if err := x.Apply(e.Ctx(time.Minute), withHostname(s, host)); err != nil {
					t.Fatalf("installing the fallback for %s: %v", host, err)
				}
				named, _ := os.ReadFile(ca)
				if bytes.Equal(named, kept) {
					t.Fatal("the fallback without a host name is kept")
				}
				if got := served(); !slices.Equal(got.DNSNames, []string{host}) {
					t.Fatalf("the database serves %v", got.DNSNames)
				}
				if out := sClient("-verify_return_error", "-CAfile", ca, "-verify_hostname", host); !regexp.MustCompile(`Verify return code: 0 \(ok\)`).MatchString(out) {
					t.Fatalf("the fallback for %s with itself as the CA and the name checked: %s", host, out)
				}
			})
		}
	})
}

// withHostname is spec with a TLS host name on its exposure.
func withHostname(spec *agentv1.ServiceSpec, host string) *agentv1.ServiceSpec {
	db := spec.GetDatabase()
	return &agentv1.ServiceSpec{Id: spec.GetId(), Kind: spec.GetKind(), KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{
		Engine: db.GetEngine(), Credentials: db.GetCredentials(),
		Exposure: &agentv1.DatabaseExposure{Enabled: true, TlsHostname: host}}}}
}

// oldFallback makes a certificate the way agents before 0.2.12 made their
// fallback: digitalSignature only.
func oldFallback(t *testing.T) (certPEM, keyPEM []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(7), Subject: pkix.Name{CommonName: "database"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(10, 0, 0),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
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
