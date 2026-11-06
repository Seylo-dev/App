package edge

import "time"

// Ticket is a verified panel-signed grant.
type Ticket struct {
	// Subject is what the ticket opens, for example "db-ui:<service id>".
	Subject string
	UserID  string
	Expires time.Time
}

// TicketVerifier checks tickets signed by the panel.
type TicketVerifier interface {
	// Verify returns the ticket if its signature, expiry, node and subject
	// are valid for wantSubject. A valid ticket is used up.
	Verify(token, wantSubject string) (Ticket, error)
	// SetKey replaces the panel's public key (it arrives in HelloAccepted).
	SetKey(publicKey []byte)
}
