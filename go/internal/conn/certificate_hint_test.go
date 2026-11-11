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
// the x509 error for callers.
func TestDialNamesTheIssuerOfAnUntrustedCertificate(t *testing.T) {
	srv := panelBehind(t, "Fortinet", "FG800D5818800524")
	err := dialErr(t, DialOptions{URL: wsURL(srv), RootCAs: x509.NewCertPool()})
	msg := err.Error()
	for _, want := range []string{"issued by Fortinet, FG800D5818800524", "TLS inspection", "exempt 127.0.0.1", "--pin"} {
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
	for _, want := range []string{"issued by Zscaler Inc., Zscaler Intermediate Root CA", "TLS inspection"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not say %q", err.Error(), want)
		}
	}
}

// Other failures get no certificate words.
func TestDialRefusedConnectionHasNoCertificateHint(t *testing.T) {
	msg := dialErr(t, DialOptions{URL: "wss://127.0.0.1:1/api/agent/connect"}).Error()
	if strings.Contains(msg, "TLS inspection") || strings.Contains(msg, "issued by") {
		t.Fatalf("error = %q", msg)
	}
}
