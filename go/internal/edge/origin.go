package edge

import (
	"crypto/ed25519"
	"encoding/base64"
	"net"
	"net/http"
	"regexp"
	"strings"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/proxy"
)

// Origin proofs. A service's custom domain behind Cloudflare's proxy
// resolves to Cloudflare's addresses, so DNS cannot tell the panel whether
// the record there points at the service's node; when it does not, Let's
// Encrypt's HTTP-01 check never reaches the node. The panel asks the host
// itself instead: GET http://<host>/.well-known/<slug>-origin/<challenge>
// (proxy.OriginPath; every route file sends it here, on the service's
// hosts, above the app's own routers). The answer is the node key's
// Ed25519 signature over
//
//	"<slug>-origin-v1" 0x00 host 0x00 challenge
//
// (OriginSignedBytes; host from the Host header, lower case, without the
// port or a trailing dot), base64url without padding plus a newline, as
// text/plain. The key is the one the agent signs its handshake with, and
// the panel checks the answer against the public keys it stores for the
// service's nodes (apps/panel/src/modules/domains/origin.ts): no secret is
// shared, and the answer tells a visitor nothing but which node's key
// signed it. The context keeps these signatures apart from the
// handshake's (rpc.HelloContext), whose bytes start differently.

// OriginContext starts every origin proof's signed bytes.
const OriginContext = brand.Slug + "-origin-v1"

// OriginCapability is advertised by agents whose edge answers OriginPath
// and whose route files send it there. The panel calls a domain
// "elsewhere" only when every node of its service advertised it.
const OriginCapability = "routing.origin-proof.v1"

// originChallenge is what the panel sends: 16 to 128 base64url characters.
var originChallenge = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// OriginSignedBytes returns what an origin proof signs.
func OriginSignedBytes(host, challenge string) []byte {
	out := make([]byte, 0, len(OriginContext)+len(host)+len(challenge)+2)
	out = append(out, OriginContext...)
	out = append(out, 0)
	out = append(out, host...)
	out = append(out, 0)
	return append(out, challenge...)
}

// SignOrigin returns the body of an origin proof: the signature, base64url
// without padding, and a newline.
func SignOrigin(key ed25519.PrivateKey, host, challenge string) string {
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, OriginSignedBytes(host, challenge))) + "\n"
}

// originHost is the Host header as the proof names it: lower case, without
// the port, brackets or a trailing dot.
func originHost(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.TrimSuffix(strings.TrimSuffix(strings.TrimPrefix(host, "["), "]"), ".")
	return strings.ToLower(host)
}

// origin answers OriginPath<challenge> with the proof. Anything else under
// the path, and every request while the agent has no key, is 404.
func (s *HTTPServer) origin(w http.ResponseWriter, r *http.Request) {
	challenge := strings.TrimPrefix(r.URL.Path, proxy.OriginPath)
	host := originHost(r.Host)
	if len(s.cfg.Identity) != ed25519.PrivateKeySize || !originChallenge.MatchString(challenge) || host == "" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_, _ = w.Write([]byte(SignOrigin(s.cfg.Identity, host, challenge)))
	}
}
