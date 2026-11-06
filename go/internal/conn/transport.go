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
		return nil, fmt.Errorf("dial panel: %w", err)
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
				return ErrPinMismatch
			}
			return nil
		},
	}
}
