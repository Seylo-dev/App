package conn

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
)

// ErrBadPin means a pin string is not a SHA-256 fingerprint.
var ErrBadPin = errors.New("conn: pin must be a SHA-256 of the panel's public key (sha256:<64 hex digits>)")

// FormatPin renders an SPKI fingerprint the way config.yml and the join
// command carry it: "sha256:" and 64 lower-case hex digits.
func FormatPin(fingerprint []byte) string {
	return "sha256:" + hex.EncodeToString(fingerprint)
}

// ParsePin accepts "sha256:<hex>", "sha256/<base64>" (the HPKP spelling),
// or the bare hex or base64 value, and returns the 32-byte fingerprint.
func ParsePin(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	for _, prefix := range []string{"sha256:", "sha256/", "SHA256:", "SHA256/"} {
		s = strings.TrimPrefix(s, prefix)
	}
	if b, err := hex.DecodeString(strings.ReplaceAll(s, ":", "")); err == nil && len(b) == sha256.Size {
		return b, nil
	}
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(s); err == nil && len(b) == sha256.Size {
			return b, nil
		}
	}
	return nil, ErrBadPin
}
