package conn

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/coder/websocket"

	"github.com/seylo-dev/app/go/gen/brand"
)

// Subprotocol is negotiated in the WebSocket handshake so a panel can
// refuse a protocol generation it does not speak before any frame flows.
const Subprotocol = brand.Slug + ".agent.v1"

// Transport moves whole frames. Implementations need not be safe for
// concurrent writers: the Writer is the only one.
type Transport interface {
	FrameSink
	// ReadFrame returns the next frame. Its payload is owned by the caller.
	ReadFrame(ctx context.Context) (Frame, error)
	// Close ends the connection, telling the peer why.
	Close(reason string) error
}

// Pinger is implemented by transports that can check the peer is still
// there. A connection can look open long after the peer vanished (no FIN
// across a dead NAT), so the agent pings and gives up on silence.
type Pinger interface {
	// Ping waits for the peer's pong. It needs a concurrent ReadFrame.
	Ping(ctx context.Context) error
}

// ErrNotBinary means the peer sent a text WebSocket message, which the
// protocol never uses.
var ErrNotBinary = errors.New("conn: received a non-binary WebSocket message")

// WebSocket is the Transport over a WebSocket connection.
type WebSocket struct {
	c *websocket.Conn
	// ServerSPKI is the SHA-256 of the panel certificate's public key, set
	// by Dial for wss:// URLs (what trust-on-first-use stores as the pin).
	ServerSPKI []byte
}

// NewWebSocket wraps an established connection.
func NewWebSocket(c *websocket.Conn) *WebSocket {
	c.SetReadLimit(MaxFrameSize)
	return &WebSocket{c: c}
}

// WriteFrame sends one frame as one binary message.
func (t *WebSocket) WriteFrame(ctx context.Context, frame []byte) error {
	return t.c.Write(ctx, websocket.MessageBinary, frame)
}

// ReadFrame reads and parses one binary message.
func (t *WebSocket) ReadFrame(ctx context.Context) (Frame, error) {
	typ, b, err := t.c.Read(ctx)
	if err != nil {
		return Frame{}, err
	}
	if typ != websocket.MessageBinary {
		return Frame{}, ErrNotBinary
	}
	return ParseFrame(b)
}

// Ping implements Pinger with a WebSocket ping.
func (t *WebSocket) Ping(ctx context.Context) error {
	return t.c.Ping(ctx)
}

// Abort drops the connection without the close handshake, for a peer
// that stopped answering (the handshake would wait for it in vain).
func (t *WebSocket) Abort() error {
	return t.c.CloseNow()
}

// Close sends a normal closure with reason.
func (t *WebSocket) Close(reason string) error {
	return t.c.Close(websocket.StatusNormalClosure, reason)
}

// DialOptions configures Dial.
type DialOptions struct {
	// URL of the panel's agent endpoint, for example
	// "wss://panel.example.com/api/agent/connect".
	URL string
	// PinSHA256 is the SHA-256 of the panel certificate's public key
	// (SPKIFingerprint). When set it replaces CA verification, which is how
	// agents trust a panel that only has a self-signed certificate. The
	// join command carries it.
	PinSHA256 []byte
	// TrustOnFirstUse accepts whatever certificate the panel presents
	// (when PinSHA256 is empty); the caller stores WebSocket.ServerSPKI as
	// the pin for every later connection. Only for the first join, and
	// only when the join command asked for it.
	TrustOnFirstUse bool
	// RootCAs verifies the certificate chain when there is no pin and no
	// trust on first use; nil means the system roots. Tests set it.
	RootCAs *x509.CertPool
	// Header is sent with the handshake request.
	Header http.Header
}

// ErrPinMismatch means the panel presented a certificate whose public key
// does not match the pin. Possibly a man in the middle: do not retry with
// verification off.
var ErrPinMismatch = errors.New("conn: panel certificate does not match the pinned key")

// Dial connects to the panel and returns the Transport.
func Dial(ctx context.Context, opts DialOptions) (*WebSocket, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	switch {
	case len(opts.PinSHA256) > 0:
		transport.TLSClientConfig = PinnedTLSConfig(opts.PinSHA256)
	case opts.TrustOnFirstUse:
		// The fingerprint is recorded below; the caller pins it from now on.
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true}
	case opts.RootCAs != nil:
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: opts.RootCAs}
	}
	c, resp, err := websocket.Dial(ctx, opts.URL, &websocket.DialOptions{
		HTTPClient:   &http.Client{Transport: transport},
		HTTPHeader:   opts.Header,
		Subprotocols: []string{Subprotocol},
	})
	if err != nil {
		return nil, fmt.Errorf("dial panel: %w%s", err, certificateHint(opts.URL, err))
	}
	if c.Subprotocol() != Subprotocol {
		c.Close(websocket.StatusProtocolError, "subprotocol not negotiated")
		return nil, fmt.Errorf("dial panel: server did not accept subprotocol %q", Subprotocol)
	}
	ws := NewWebSocket(c)
	if resp != nil && resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
		ws.ServerSPKI = SPKIFingerprint(resp.TLS.PeerCertificates[0])
	}
	return ws, nil
}

// pinMismatchError is ErrPinMismatch with who issued the certificate that
// came instead (errors.Is(err, ErrPinMismatch) holds).
type pinMismatchError struct{ issuer string }

func (e *pinMismatchError) Error() string {
	return fmt.Sprintf("%s (the certificate presented was issued by %s)", ErrPinMismatch.Error(), e.issuer)
}

func (e *pinMismatchError) Unwrap() error { return ErrPinMismatch }

// IssuerName is a certificate's issuer for people: organization and common
// name, for example "Fortinet, FG800D5818800524"; "an unnamed issuer" when
// both are empty.
func IssuerName(cert *x509.Certificate) string {
	var parts []string
	for _, o := range cert.Issuer.Organization {
		if o = strings.TrimSpace(o); o != "" {
			parts = append(parts, o)
		}
	}
	if cn := strings.TrimSpace(cert.Issuer.CommonName); cn != "" && !slices.Contains(parts, cn) {
		parts = append(parts, cn)
	}
	if len(parts) == 0 {
		return "an unnamed issuer"
	}
	return strings.Join(parts, ", ")
}

// certificateHint says what a refused certificate most likely means, for
// the dial error people read in seylo status and the installer: "" when
// the failure is not about the certificate.
//
// A certificate from a CA this server does not trust is, on a panel with a
// public certificate, nearly always a firewall or proxy that decrypts HTTPS
// on the way (TLS inspection: FortiGate, Zscaler, Palo Alto and the like
// re-sign every site with their own CA). Traefik's own self-signed
// certificate means the panel's server has no certificate for the name yet.
func certificateHint(rawURL string, err error) string {
	host := rawURL
	if u, perr := url.Parse(rawURL); perr == nil && u.Hostname() != "" {
		host = u.Hostname()
	}
	var pinned *pinMismatchError
	if errors.As(err, &pinned) {
		return fmt.Sprintf(". %s did not present the panel's pinned key: a firewall or proxy on this server's network may decrypt HTTPS (TLS inspection), or the address leads to another server", host)
	}
	var verify *tls.CertificateVerificationError
	if !errors.As(err, &verify) || len(verify.UnverifiedCertificates) == 0 {
		return ""
	}
	var unknown x509.UnknownAuthorityError
	if !errors.As(err, &unknown) {
		return ""
	}
	leaf := verify.UnverifiedCertificates[0]
	issuer := IssuerName(leaf)
	if strings.EqualFold(leaf.Issuer.CommonName, "TRAEFIK DEFAULT CERT") {
		return fmt.Sprintf(". %s answers with Traefik's own certificate: the panel's server has no certificate for that name yet (see the panel domain's status)", host)
	}
	return fmt.Sprintf(". The certificate for %s was issued by %s, which this server does not trust. If that is not who issued the panel's certificate, a firewall or proxy on this server's network decrypts HTTPS (TLS inspection): exempt %s from it, or join with the panel's IP address and --pin", host, issuer, host)
}

// SPKIFingerprint returns the SHA-256 of a certificate's public key. Pinning
// the key instead of the certificate survives certificate renewal.
func SPKIFingerprint(cert *x509.Certificate) []byte {
	sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	return sum[:]
}

// PinnedTLSConfig accepts exactly the server key whose SPKIFingerprint is
// pin, instead of verifying a CA chain (panels without a public
// certificate). Any HTTPS request to the panel, not only the agent
// WebSocket, uses it then.
func PinnedTLSConfig(pin []byte) *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		// Chain verification is replaced, not skipped: VerifyConnection
		// below accepts exactly one public key.
		InsecureSkipVerify: true,
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return ErrPinMismatch
			}
			if subtle.ConstantTimeCompare(SPKIFingerprint(cs.PeerCertificates[0]), pin) != 1 {
				return &pinMismatchError{issuer: IssuerName(cs.PeerCertificates[0])}
			}
			return nil
		},
	}
}
