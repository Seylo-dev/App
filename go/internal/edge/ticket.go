package edge

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
)

// Ticket wire format (the panel signs, the agent verifies):
//
//	ticket    = base64url(payload) "." base64url(signature)   (no padding)
//	payload   = UTF-8 JSON {"v":1,"sub":"box:<service id>","uid":"<user id>",
//	            "exp":<unix seconds>,"jti":"<random>"} (optional "nid")
//	signature = Ed25519(edge ticket private key,
//	            TicketContext + 0x00 + payload string as sent)
//
// sub is the tool the ticket opens (proxy.ToolSubject: "box:<id>" or
// "db-ui:<id>"). exp may be up to ClockSkew in the past and at most
// MaxTicketLifetime ahead. nid, when set, must be this node. jti is single
// use: a ticket opens once. The panel links to
// https://<proxy.ToolHost>/_seylo/ticket?t=<ticket>.
const TicketContext = brand.Slug + "-edge-ticket-v1"

// MaxTicketLifetime bounds how far in the future a ticket may expire.
const MaxTicketLifetime = 15 * time.Minute

// ClockSkew is how far past exp a ticket is still accepted (panel and node
// clocks differ a little).
const ClockSkew = 30 * time.Second

func signedBytes(payloadB64 string) []byte {
	return append([]byte(TicketContext+"\x00"), payloadB64...)
}

// Ticket errors. All of them mean "refuse"; they differ for logs.
var (
	ErrNoKey         = errors.New("edge ticket key not received from the panel yet")
	ErrInvalidTicket = errors.New("invalid edge ticket")
	ErrTicketExpired = errors.New("edge ticket expired")
	ErrTicketUsed    = errors.New("edge ticket already used")
)

type ticketClaims struct {
	V   int    `json:"v"`
	Sub string `json:"sub"`
	UID string `json:"uid"`
	NID string `json:"nid,omitempty"`
	Exp int64  `json:"exp"`
	JTI string `json:"jti"`
}

// Verifier checks panel-signed tickets locally with the key from
// HelloAccepted and remembers used ticket ids until they expire.
type Verifier struct {
	nodeID string
	now    func() time.Time

	mu   sync.Mutex
	key  ed25519.PublicKey
	used map[string]time.Time
}

// NewVerifier returns a verifier for this node (nodeID may be empty before
// the node joined; then tickets naming a node are refused).
func NewVerifier(nodeID string) *Verifier {
	return &Verifier{nodeID: nodeID, now: time.Now, used: map[string]time.Time{}}
}

// SetKey implements TicketVerifier. A key of the wrong size clears it.
func (v *Verifier) SetKey(publicKey []byte) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if len(publicKey) != ed25519.PublicKeySize {
		v.key = nil
		return
	}
	v.key = append(ed25519.PublicKey(nil), publicKey...)
}

// SetNodeID sets the node id tickets must name (after joining).
func (v *Verifier) SetNodeID(nodeID string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.nodeID = nodeID
}

// Verify implements TicketVerifier. A valid ticket is consumed.
func (v *Verifier) Verify(token, wantSubject string) (Ticket, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.key == nil {
		return Ticket{}, ErrNoKey
	}
	payloadB64, sigB64, ok := strings.Cut(token, ".")
	if !ok || payloadB64 == "" || len(token) > 4096 {
		return Ticket{}, ErrInvalidTicket
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return Ticket{}, ErrInvalidTicket
	}
	if !ed25519.Verify(v.key, signedBytes(payloadB64), sig) {
		return Ticket{}, ErrInvalidTicket
	}
	raw, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return Ticket{}, ErrInvalidTicket
	}
	var c ticketClaims
	if err := json.Unmarshal(raw, &c); err != nil || c.V != 1 || c.JTI == "" || c.Sub == "" {
		return Ticket{}, ErrInvalidTicket
	}
	if c.Sub != wantSubject {
		return Ticket{}, fmt.Errorf("%w: for %q, not %q", ErrInvalidTicket, c.Sub, wantSubject)
	}
	if c.NID != "" && c.NID != v.nodeID {
		return Ticket{}, fmt.Errorf("%w: for another node", ErrInvalidTicket)
	}
	now := v.now()
	exp := time.Unix(c.Exp, 0)
	if !exp.Add(ClockSkew).After(now) {
		return Ticket{}, ErrTicketExpired
	}
	if exp.After(now.Add(MaxTicketLifetime)) {
		return Ticket{}, fmt.Errorf("%w: lifetime too long", ErrInvalidTicket)
	}
	for id, until := range v.used {
		if !until.After(now) {
			delete(v.used, id)
		}
	}
	if _, seen := v.used[c.JTI]; seen {
		return Ticket{}, ErrTicketUsed
	}
	v.used[c.JTI] = exp.Add(ClockSkew)
	return Ticket{Subject: c.Sub, UserID: c.UID, Expires: exp}, nil
}

// SignTicket makes a ticket. The panel signs its own; this is for
// tests and tools.
func SignTicket(key ed25519.PrivateKey, subject, userID, nodeID, jti string, expires time.Time) string {
	payload, _ := json.Marshal(ticketClaims{V: 1, Sub: subject, UID: userID, NID: nodeID, Exp: expires.Unix(), JTI: jti})
	p := base64.RawURLEncoding.EncodeToString(payload)
	sig := ed25519.Sign(key, signedBytes(p))
	return p + "." + base64.RawURLEncoding.EncodeToString(sig)
}

var _ TicketVerifier = (*Verifier)(nil)
