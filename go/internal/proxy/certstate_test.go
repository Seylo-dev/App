package proxy

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// traefikColorFailure is a line as Traefik v3.7 writes it to docker logs
// (colours included) when the CA cannot validate the host.
const traefikColorFailure = "\x1b[90m2026-11-05T14:11:45Z\x1b[0m \x1b[31mERR\x1b[0m \x1b[1mUnable to obtain ACME certificate for domains\x1b[0m \x1b[36merror=\x1b[0m\x1b[31m\x1b[1m\"unable to generate a certificate for the domains [nowhere.it.test]: resolver: one or more domains had a problem: [nowhere.it.test: invalid authorization: acme: error: 400 :: urn:ietf:params:acme:error:connection :: Get \\\"http://nowhere.it.test:5002/.well-known/acme-challenge/x\\\": lookup nowhere.it.test on 127.0.0.11:53: no such host]\"\x1b[0m\x1b[0m \x1b[36mACME CA=\x1b[0mhttps://pebble:14000/dir \x1b[36mdomains=\x1b[0m[\"nowhere.it.test\"] \x1b[36mproviderName=\x1b[0mle.acme"

// Real Traefik v3 lines (domains shortened), text and JSON formats.
const (
	traefikTextFailure = `2026-11-05T10:00:00Z ERR Unable to obtain ACME certificate for domains error="unable to generate a certificate for the domains [bad.example.com]: error: one or more domains had a problem:\n[bad.example.com] acme: error: 400 :: urn:ietf:params:acme:error:connection :: 203.0.113.10: Fetching http://bad.example.com/.well-known/acme-challenge/x: Timeout during connect (likely firewall problem)\n" ACME CA=https://acme-v02.api.letsencrypt.org/directory acmeCA=https://acme-v02.api.letsencrypt.org/directory domains=["bad.example.com"] providerName=le.acme routerName=seylo-svc1-r-secure@file rule=Host(` + "`bad.example.com`" + `)`
	traefikJSONFailure = `{"level":"error","acmeCA":"https://acme-v02.api.letsencrypt.org/directory","domains":["json.example.com"],"providerName":"le.acme","error":"unable to generate a certificate for the domains [json.example.com]: error: one or more domains had a problem:\n[json.example.com] acme: error: 429 :: urn:ietf:params:acme:error:rateLimited :: too many certificates already issued\n","time":"2026-11-05T10:00:00Z","message":"Unable to obtain ACME certificate for domains"}`
)

func TestParseAcmeFailure(t *testing.T) {
	for _, tc := range []struct {
		line, host, want string
	}{
		{traefikColorFailure, "nowhere.it.test", "(400): Get \"http://nowhere.it.test:5002/"},
		{traefikTextFailure, "bad.example.com", "(400): 203.0.113.10: Fetching"},
		{traefikJSONFailure, "json.example.com", "(429): too many certificates already issued"},
		{`2026-11-05T10:00:00Z ERR Unable to obtain ACME certificate for domains error="unable to generate a certificate for the domains [a.example.com b.example.com]: boom"`, "b.example.com", "boom"},
	} {
		hosts, msg, at, ok := parseAcmeFailure(tc.line)
		if !ok || !strings.Contains(strings.Join(hosts, " "), tc.host) || !strings.Contains(msg, tc.want) || at.IsZero() {
			t.Errorf("parse %q: hosts %v msg %q at %v ok %v", tc.host, hosts, msg, at, ok)
		}
	}
	for _, line := range []string{
		"2026-11-05T10:00:00Z INF Starting provider *acme.ChallengeTLSALPN",
		`2026-11-05T10:00:00Z ERR Unable to obtain ACME certificate for domains error="no domains here"`,
	} {
		if _, _, _, ok := parseAcmeFailure(line); ok {
			t.Errorf("parsed %q", line)
		}
	}
}

func TestCertFailuresExpireAndForget(t *testing.T) {
	f := NewCertFailures()
	now := time.Date(2026, 11, 5, 11, 0, 0, 0, time.UTC)
	f.now = func() time.Time { return now }
	f.Observe(traefikTextFailure)
	if _, ok := f.Failure("BAD.example.com"); !ok {
		t.Fatal("failure not recorded")
	}
	now = now.Add(failureTTL + time.Hour)
	if _, ok := f.Failure("bad.example.com"); ok {
		t.Fatal("failure did not expire")
	}
	now = time.Date(2026, 11, 5, 11, 0, 0, 0, time.UTC)
	f.Forget("bad.example.com")
	if _, ok := f.Failure("bad.example.com"); ok {
		t.Fatal("failure not forgotten")
	}
}

// selfSigned returns a PEM certificate and key for host, self-issued.
func selfSignedFor(t *testing.T, host string, notAfter time.Time) (string, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: host},
		DNSNames: []string{host}, NotBefore: notAfter.Add(-90 * 24 * time.Hour), NotAfter: notAfter,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kder, _ := x509.MarshalECPrivateKey(key)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}))
}

func TestRouteStatusCertificates(t *testing.T) {
	dir := t.TempDir()
	acme := filepath.Join(dir, "acme.json")
	expires := time.Now().Add(60 * 24 * time.Hour).Truncate(time.Second).UTC()
	cert, key := selfSignedFor(t, "ok.example.com", expires)
	b64 := base64.StdEncoding.EncodeToString
	_ = os.WriteFile(acme, []byte(`{"le":{"Certificates":[{"domain":{"main":"ok.example.com"},"certificate":"`+b64([]byte(cert))+`","key":"`+b64([]byte(key))+`"}]}}`), 0o600)
	failures := NewCertFailures()
	failures.Observe(traefikTextFailure)
	r := NewFileRouter(FileConfig{Dir: filepath.Join(dir, "dynamic"), AcmeFile: acme, CertFailures: failures})
	customExp := time.Now().Add(10 * 24 * time.Hour).Truncate(time.Second).UTC()
	ccert, ckey := selfSignedFor(t, "custom.example.com", customExp)
	spec := app("svc1", route("ok", "ok.example.com"), route("bad", "bad.example.com"), route("wait", "wait.example.com"),
		&agentv1.Route{Id: "custom", Hosts: []string{"custom.example.com"}, Https: agentv1.HttpsMode_HTTPS_MODE_CUSTOM_CERTIFICATE,
			Certificate: &agentv1.Certificate{CertPem: ccert, KeyPem: ckey}})
	ctx := context.Background()
	if err := r.Apply(ctx, spec, ups("http://x:1")); err != nil {
		t.Fatal(err)
	}
	got, err := r.Status(ctx, "svc1")
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]*agentv1.RouteStatus{}
	for _, st := range got {
		by[st.GetRouteId()] = st
	}
	if st := by["ok"]; st.GetState() != agentv1.RouteState_ROUTE_STATE_ACTIVE || st.GetCertificateIssuer() != "ok.example.com" || !st.GetCertificateExpiresAt().AsTime().Equal(expires) {
		t.Errorf("ok: %v", st)
	}
	if st := by["bad"]; st.GetState() != agentv1.RouteState_ROUTE_STATE_CERTIFICATE_FAILED || !strings.Contains(st.GetMessage(), "Timeout during connect") {
		t.Errorf("bad: %v", st)
	}
	if st := by["wait"]; st.GetState() != agentv1.RouteState_ROUTE_STATE_CERTIFICATE_PENDING || st.GetCertificateExpiresAt() != nil {
		t.Errorf("wait: %v", st)
	}
	if st := by["custom"]; st.GetState() != agentv1.RouteState_ROUTE_STATE_ACTIVE || !st.GetCertificateExpiresAt().AsTime().Equal(customExp) {
		t.Errorf("custom: %v", st)
	}
}
