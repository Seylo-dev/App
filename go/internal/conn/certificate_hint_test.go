package conn

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode"
)

// panelBehind serves TLS with a leaf for 127.0.0.1 signed by a CA named
// issuer (Organization, CommonName), as a TLS-inspecting firewall does.
func panelBehind(t *testing.T, org, cn string) *httptest.Server {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{Organization: []string{org}, CommonName: cn},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	if org == "" {
		caTmpl.Subject.Organization = nil
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, _ := x509.ParseCertificate(caDER)
	leafKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	leafTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "panel.example.com"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTmpl, ca, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{leafDER, caDER}, PrivateKey: leafKey}}}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv
}

func dialErr(t *testing.T, opts DialOptions) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := Dial(ctx, opts)
	if err == nil {
		t.Fatal("dial succeeded")
	}
	return err
}

// A firewall that decrypts HTTPS re-signs the panel's certificate with its
// own CA: the error names that issuer and says what it likely is, and keeps
// the x509 error for callers. A node that joined over the domain is told it
// can keep its node and point it at the panel's IP (set-panel).
func TestDialNamesTheIssuerOfAnUntrustedCertificate(t *testing.T) {
	srv := panelBehind(t, "Fortinet", "FG800D5818800524")
	err := dialErr(t, DialOptions{URL: wsURL(srv), RootCAs: x509.NewCertPool()})
	msg := err.Error()
	for _, want := range []string{`says it was issued by "Fortinet, FG800D5818800524"`, "TLS inspection", "exempt 127.0.0.1", "--pin",
		"or point this node at the panel's IP with `seylo set-panel`"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error %q does not say %q", msg, want)
		}
	}
	var unknown x509.UnknownAuthorityError
	if !errors.As(err, &unknown) {
		t.Fatalf("error %v lost the x509 error", err)
	}
}

// Traefik's own certificate means no certificate for the name yet, not a firewall.
func TestDialSaysTraefikHasNoCertificateYet(t *testing.T) {
	srv := panelBehind(t, "", "TRAEFIK DEFAULT CERT")
	msg := dialErr(t, DialOptions{URL: wsURL(srv), RootCAs: x509.NewCertPool()}).Error()
	if !strings.Contains(msg, "Traefik's own certificate") || strings.Contains(msg, "TLS inspection") {
		t.Fatalf("error = %q", msg)
	}
}

// A pinned panel behind a firewall that decrypts HTTPS: still ErrPinMismatch, now with who issued what came.
func TestDialPinMismatchNamesTheIssuer(t *testing.T) {
	srv := panelBehind(t, "Zscaler Inc.", "Zscaler Intermediate Root CA")
	err := dialErr(t, DialOptions{URL: wsURL(srv), PinSHA256: make([]byte, 32)})
	if !errors.Is(err, ErrPinMismatch) {
		t.Fatalf("err = %v, want ErrPinMismatch", err)
	}
	for _, want := range []string{`says it was issued by "Zscaler Inc., Zscaler Intermediate Root CA"`, "TLS inspection"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not say %q", err.Error(), want)
		}
	}
}

// forgedIssuer is an issuer organization a TLS peer could choose: a line
// break and a fake seylo status line, terminal escapes (erase the line,
// right-to-left override) and length.
const forgedIssuer = "Let's Encrypt\nPanel:   https://panel.example.com (connected)\r\x1b[2K\u202e\tdone" +
	"                                                                and then a lot more text"

// Whoever answers the TLS handshake chooses the issuer, and the error with
// it goes to seylo status, the installer and the panel's alerts: one
// quoted line of printable text, short, whatever the certificate says.
func TestDialQuotesAForgedIssuerOnOneLine(t *testing.T) {
	srv := panelBehind(t, forgedIssuer, "CN")
	for name, opts := range map[string]DialOptions{
		"untrusted": {URL: wsURL(srv), RootCAs: x509.NewCertPool()},
		"pinned":    {URL: wsURL(srv), PinSHA256: make([]byte, 32)},
	} {
		msg := dialErr(t, opts).Error()
		if strings.ContainsFunc(msg, func(r rune) bool { return unicode.IsControl(r) || !unicode.IsPrint(r) }) {
			t.Errorf("%s: error %q has control or unprintable runes", name, msg)
		}
		want := `issued by "Let's Encrypt Panel: https://panel.example.com (connected) [2K done and then..."`
		if !strings.Contains(msg, want) {
			t.Errorf("%s: error %q does not say %s", name, msg, want)
		}
	}
}

func TestIssuerName(t *testing.T) {
	for _, tc := range []struct {
		org  []string
		cn   string
		want string
	}{
		{[]string{"Fortinet"}, "FG800D5818800524", "Fortinet, FG800D5818800524"},
		{[]string{" Zscaler  Inc. "}, "Zscaler  Inc.", "Zscaler Inc."},
		{[]string{"\x1b[31mred", ""}, "\n", "[31mred"},
		{[]string{"\x1b\x00", ""}, "\n\t", ""},
		{nil, strings.Repeat("ab", 60), strings.Repeat("ab", 38) + "a..."},
		{[]string{"שלום\u200b עולם"}, "", "שלום עולם"},
	} {
		cert := &x509.Certificate{Issuer: pkix.Name{Organization: tc.org, CommonName: tc.cn}}
		if got := IssuerName(cert); got != tc.want {
			t.Errorf("IssuerName(%q, %q) = %q, want %q", tc.org, tc.cn, got, tc.want)
		}
	}
	if got := claimedIssuer(&x509.Certificate{}); got != "an unnamed issuer" {
		t.Errorf("claimedIssuer of no name = %q", got)
	}
	if got := claimedIssuer(&x509.Certificate{Issuer: pkix.Name{CommonName: `Say "hi"`}}); got != `"Say \"hi\""` {
		t.Errorf("claimedIssuer = %s", got)
	}
}

// Other failures get no certificate words.
func TestDialRefusedConnectionHasNoCertificateHint(t *testing.T) {
	msg := dialErr(t, DialOptions{URL: "wss://127.0.0.1:1/api/agent/connect"}).Error()
	if strings.Contains(msg, "TLS inspection") || strings.Contains(msg, "issued by") {
		t.Fatalf("error = %q", msg)
	}
}

// Traefik's own certificate is told apart from TLS inspection for callers
// too (the agent dials a fallback at once only on inspection), also when it
// came in place of the pinned key; a firewall's CA is not Traefik's.
func TestTraefikDefaultCertificate(t *testing.T) {
	traefik := panelBehind(t, "", "TRAEFIK DEFAULT CERT")
	firewall := panelBehind(t, "Fortinet", "FG800D5818800524")
	for _, tc := range []struct {
		name string
		opts DialOptions
		want bool
	}{
		{"untrusted Traefik default", DialOptions{URL: wsURL(traefik), RootCAs: x509.NewCertPool()}, true},
		{"Traefik default in place of the pin", DialOptions{URL: wsURL(traefik), PinSHA256: make([]byte, 32)}, true},
		{"untrusted firewall CA", DialOptions{URL: wsURL(firewall), RootCAs: x509.NewCertPool()}, false},
		{"firewall CA in place of the pin", DialOptions{URL: wsURL(firewall), PinSHA256: make([]byte, 32)}, false},
		{"refused connection", DialOptions{URL: "wss://127.0.0.1:1/api/agent/connect"}, false},
	} {
		err := dialErr(t, tc.opts)
		if got := TraefikDefaultCertificate(err); got != tc.want {
			t.Errorf("%s: TraefikDefaultCertificate = %v, want %v (%v)", tc.name, got, tc.want, err)
		}
	}
	msg := dialErr(t, DialOptions{URL: wsURL(traefik), PinSHA256: make([]byte, 32)}).Error()
	if !strings.Contains(msg, "answers with Traefik's own certificate") || strings.Contains(msg, "TLS inspection") {
		t.Fatalf("pinned error = %q", msg)
	}
}
