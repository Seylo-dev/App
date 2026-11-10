package edge

import (
	"crypto/ed25519"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/seylo-dev/app/go/internal/proxy"
)

// originVector is shared with the panel's verifier
// (apps/panel/test/domain-origin.test.ts): the key from seed 0x01..0x20,
// host shop.example.com, challenge originVectorChallenge.
const (
	originVectorPublic    = "ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ"
	originVectorChallenge = "Zm9yLXRoZS1vcmlnaW4tdGVzdA"
	originVectorProof     = "jd34eehjI9eUBT_0Dtz4E2IeXTIteq1XT1YdJijGbaUll0tVsAobiz9XcC9V-xZWGPfjwBp14tPFkADxV7qLCQ"
)

func vectorKey() ed25519.PrivateKey {
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	return ed25519.NewKeyFromSeed(seed)
}

func TestOriginVector(t *testing.T) {
	key := vectorKey()
	pub := base64.RawURLEncoding.EncodeToString(key.Public().(ed25519.PublicKey))
	proof := SignOrigin(key, "shop.example.com", originVectorChallenge)
	if pub != originVectorPublic || proof != originVectorProof+"\n" {
		t.Fatalf("vector changed: public %s proof %q", pub, proof)
	}
	if got := string(OriginSignedBytes("a.example.com", "c")); got != "seylo-origin-v1\x00a.example.com\x00c" {
		t.Fatalf("signed bytes %q", got)
	}
}

func TestOriginProof(t *testing.T) {
	pub, priv := newKey(t)
	s := NewHTTPServer(Config{Identity: priv})
	challenge := "abcdefghijklmnop_-0123456789ABCD"
	get := func(method, host, path string, header ...string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, nil)
		r.Host = host
		for i := 0; i+1 < len(header); i += 2 {
			r.Header.Set(header[i], header[i+1])
		}
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, r)
		return rec
	}
	verify := func(rec *httptest.ResponseRecorder, host string) bool {
		t.Helper()
		sig, err := base64.RawURLEncoding.DecodeString(strings.TrimSuffix(rec.Body.String(), "\n"))
		return err == nil && ed25519.Verify(pub, OriginSignedBytes(host, challenge), sig)
	}

	rec := get(http.MethodGet, "Shop.Example.COM:80", proxy.OriginPath+challenge)
	if rec.Code != http.StatusOK || !verify(rec, "shop.example.com") {
		t.Fatalf("proof: %d %q", rec.Code, rec.Body.String())
	}
	if ct, cc := rec.Header().Get("Content-Type"), rec.Header().Get("Cache-Control"); ct != "text/plain; charset=utf-8" || cc != "no-store" ||
		rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("headers %v", rec.Header())
	}
	// The host is part of what is signed: a proof for one host is no proof for another.
	if verify(rec, "other.example.com") {
		t.Fatal("the proof does not name the host")
	}
	// A trailing dot and IPv6 brackets do not change the name.
	if rec := get(http.MethodGet, "shop.example.com.", proxy.OriginPath+challenge); !verify(rec, "shop.example.com") {
		t.Fatalf("trailing dot: %q", rec.Body.String())
	}
	if rec := get(http.MethodGet, "[2001:DB8::1]:443", proxy.OriginPath+challenge); !verify(rec, "2001:db8::1") {
		t.Fatalf("IPv6 host: %q", rec.Body.String())
	}
	// A tool header a visitor sent does not turn it into a sign-in page.
	if rec := get(http.MethodGet, "shop.example.com", proxy.OriginPath+challenge, proxy.HeaderTool, "box:b1"); !verify(rec, "shop.example.com") {
		t.Fatalf("with a tool header: %d", rec.Code)
	}
	if rec := get(http.MethodHead, "shop.example.com", proxy.OriginPath+challenge); rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("HEAD: %d %q", rec.Code, rec.Body.String())
	}
	if rec := get(http.MethodPost, "shop.example.com", proxy.OriginPath+challenge); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST: %d", rec.Code)
	}

	for name, path := range map[string]string{
		"no challenge":   proxy.OriginPath,
		"too short":      proxy.OriginPath + "abc",
		"too long":       proxy.OriginPath + strings.Repeat("a", 129),
		"not url-safe":   proxy.OriginPath + "abcdefghijklmnop+/",
		"a dot":          proxy.OriginPath + "abcdefghijklmnop.x",
		"another folder": proxy.OriginPath + challenge + "/x",
	} {
		if rec := get(http.MethodGet, "shop.example.com", path); rec.Code != http.StatusNotFound {
			t.Errorf("%s: %d %q", name, rec.Code, rec.Body.String())
		}
	}
	// Without the node key there is nothing to prove with.
	unkeyed := NewHTTPServer(Config{})
	rec = httptest.NewRecorder()
	unkeyed.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, proxy.OriginPath+challenge, nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("no key: %d", rec.Code)
	}
}
