//go:build integration

package proxy

// The visitor country header against real Traefik in the test VM: the app
// gets X-Seylo-Country from the lookup server, whatever the visitor sends
// under that name or an alias of it, over IPv4 and IPv6, through Cloudflare
// (a visitor from Cloudflare's addresses names the real visitor in
// CF-Connecting-IP), through another node's LB entry point, and with the
// header off for the service only the strip.
//
//	scripts/dev/vm-gotest.sh ./internal/proxy -run IntegrationCountry -v

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/geoip"
	"github.com/seylo-dev/app/go/internal/geoip/geoiptest"
)

// headerDump answers with every request header it got, as JSON.
func headerDump(t *testing.T, e *itEnv) Upstream {
	t.Helper()
	l, err := net.Listen("tcp", net.JoinHostPort(e.traefik.Gateway, "0"))
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(r.Header)
	})}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	return Upstream{URL: "http://" + l.Addr().String()}
}

// countryServer runs the lookup server on the edge gateway, as the
// agent's systemd unit does, with a database that knows the test nets.
func countryServer(t *testing.T, e *itEnv) CountryLookup {
	t.Helper()
	path := filepath.Join(t.TempDir(), "country.mmdb")
	db := geoiptest.Write("DBIP-Country-Lite", time.Now(),
		geoiptest.N("198.18.0.0/15", "IL"), // every visitor from newVisitor
		geoiptest.N("2001:db8::/32", "DE"), // their IPv6 addresses
		geoiptest.N("81.2.3.0/24", "FR"),   // the visitor behind Cloudflare
	)
	if err := writeAtomic(filepath.Dir(path), filepath.Base(path), db); err != nil {
		t.Fatal(err)
	}
	l, err := net.Listen("tcp", net.JoinHostPort(e.traefik.Gateway, "0"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = (&geoip.Server{Path: path}).Serve(ctx, l) }()
	return CountryLookup{Address: "http://" + l.Addr().String() + "/", MaxResponseBodySize: true}
}

// headersSeen asks the dump through c, retrying while Traefik loads the
// route (a 404) or the middleware.
func headersSeen(t *testing.T, c *http.Client, url string, set map[string]string) http.Header {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		for k, v := range set {
			// Set as is: Go would canonicalize X_Seylo_Country's case only.
			req.Header[k] = []string{v}
		}
		resp, err := c.Do(req)
		if err == nil {
			body, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			var h http.Header
			if resp.StatusCode == 200 && json.Unmarshal(body, &h) == nil {
				return h
			}
			err = fmt.Errorf("%d %q", resp.StatusCode, body)
		}
		if time.Now().After(deadline) {
			t.Fatalf("GET %s: %v", url, err)
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// countryOf is what the app got: the header's values, and every alias
// spelling that reached it.
func countryOf(h http.Header) (values []string, aliases []string) {
	for k, v := range h {
		lk := strings.ToLower(k)
		if lk == "x-seylo-country" {
			values = append(values, v...)
			continue
		}
		if strings.Contains(lk, "seylo") && strings.Contains(lk, "country") {
			aliases = append(aliases, k)
		}
	}
	return values, aliases
}

// forged is what a visitor sends to pass as another country.
var forged = map[string]string{
	"X-Seylo-Country": "US",
	"X_Seylo_Country": "US",
	"X-Seylo_Country": "US",
	"X.Seylo.Country": "US",
	"x-seylo-country": "US",
}

func TestIntegrationCountryHeader(t *testing.T) {
	n := newTwoNodes(t, withVisitorIPv6)
	e := n.e
	lookup := countryServer(t, e)
	n.rb.SetCountry(lookup)
	n.ra.SetCountry(lookup)
	dump := headerDump(t, e)
	routes := func() *agentv1.ServiceSpec { return app("sgeo", anyPortRoute("r1", "geo.it.test")) }
	n.applyB(t, routes(), []Upstream{dump})
	n.applyA(t, routes(), nil)
	vis := newVisitor(t, e)
	cf := newVisitorIn(t, e, "173.245.48") // one of Cloudflare's networks

	cases := []struct {
		name   string
		client *http.Client
		set    map[string]string
		want   string
	}{
		{"IPv4", vis.client(net.JoinHostPort(vis.hostV4, fmt.Sprint(e.httpPort)), false), nil, "IL"},
		{"IPv4 with forged headers", vis.client(net.JoinHostPort(vis.hostV4, fmt.Sprint(e.httpPort)), false), forged, "IL"},
		{"IPv6", vis.client(net.JoinHostPort(vis.hostV6, fmt.Sprint(e.httpPort)), false), nil, "DE"},
		{"a direct visitor naming another in CF-Connecting-IP", vis.client(net.JoinHostPort(vis.hostV4, fmt.Sprint(e.httpPort)), false),
			map[string]string{"Cf-Connecting-Ip": "81.2.3.4", "X-Seylo-Country": "FR"}, "IL"},
		{"through Cloudflare", cf.client(net.JoinHostPort(cf.hostV4, fmt.Sprint(e.httpPort)), false),
			map[string]string{"Cf-Connecting-Ip": "81.2.3.4", "X-Seylo-Country": "US"}, "FR"},
		{"through another node", vis.client(net.JoinHostPort(vis.hostV4, fmt.Sprint(n.aHTTP)), false), forged, "IL"},
		{"through another node over IPv6", vis.client(net.JoinHostPort(vis.hostV6, fmt.Sprint(n.aHTTP)), false), nil, "DE"},
	}
	for _, c := range cases {
		h := headersSeen(t, c.client, "http://geo.it.test/", c.set)
		values, aliases := countryOf(h)
		if len(values) != 1 || values[0] != c.want {
			t.Errorf("%s: the app got X-Seylo-Country %q, want %q", c.name, values, c.want)
		}
		if len(aliases) > 0 {
			t.Errorf("%s: forged aliases reached the app: %v", c.name, aliases)
		}
	}

	// Off for the service: no country, and still nothing forged.
	off := routes()
	off.Routing.NoCountryHeader = true
	n.applyB(t, off, []Upstream{dump})
	deadline := time.Now().Add(30 * time.Second)
	for {
		h := headersSeen(t, vis.client(net.JoinHostPort(vis.hostV4, fmt.Sprint(e.httpPort)), false), "http://geo.it.test/",
			map[string]string{"X-Seylo-Country": "US", "X_Seylo_Country": "US"})
		values, aliases := countryOf(h)
		if len(values) == 0 && len(aliases) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("header off: the app still got %q and aliases %v", values, aliases)
		}
		time.Sleep(300 * time.Millisecond)
	}
}
