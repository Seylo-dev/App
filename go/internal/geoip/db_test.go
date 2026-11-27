package geoip

import (
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/geoip/geoiptest"
)

var testBuilt = time.Date(2026, 11, 1, 3, 0, 0, 0, time.UTC)

func testDB(t *testing.T, networks ...geoiptest.Network) *DB {
	t.Helper()
	if len(networks) == 0 {
		networks = testNetworks
	}
	db, err := Open(geoiptest.Write("DBIP-Country-Lite", testBuilt, networks...))
	if err != nil {
		t.Fatal(err)
	}
	return db
}

var testNetworks = []geoiptest.Network{
	geoiptest.N("81.0.0.0/8", "DE"),
	geoiptest.N("2.16.0.0/13", "fr"),
	geoiptest.N("88.214.55.0/24", "IL"),
	geoiptest.N("2001:db8:1::/48", "ES"),
	geoiptest.N("2a00:1450::/32", "US"),
	geoiptest.N("5.5.5.0/24", "E1"),
}

func TestCountry(t *testing.T) {
	db := testDB(t)
	cases := map[string]string{
		"81.2.3.4":                 "DE",
		"2.17.1.1":                 "FR", // lower case in the file
		"88.214.55.20":             "IL",
		"::ffff:88.214.55.20":      "IL", // IPv4-mapped
		"2a00:1450:4001:80b::200e": "US",
		"2001:db8:1:2::1":          "ES",
		"8.8.8.8":                  Unknown, // not in the file
		"10.1.2.3":                 Unknown, // private
		"127.0.0.1":                Unknown,
		"172.30.0.1":               Unknown,
		"fe80::1":                  Unknown,
		"5.5.5.5":                  Unknown, // not two letters
	}
	for ip, want := range cases {
		if got := db.Country(netip.MustParseAddr(ip)); got != want {
			t.Errorf("Country(%s) = %q, want %q", ip, got, want)
		}
	}
	if got := (*DB)(nil).Country(netip.MustParseAddr("81.2.3.4")); got != Unknown {
		t.Errorf("nil DB: %q", got)
	}
	if got := db.Country(netip.Addr{}); got != Unknown {
		t.Errorf("zero address: %q", got)
	}
}

func TestOpenInfoAndVerify(t *testing.T) {
	db := testDB(t)
	i := db.Info()
	if i.Type != "DBIP-Country-Lite" || !i.Built.Equal(testBuilt) || i.Size == 0 {
		t.Errorf("Info() = %+v", i)
	}
	if err := db.Verify(); err != nil {
		t.Errorf("Verify: %v", err)
	}
}

func TestOpenRefuses(t *testing.T) {
	if _, err := Open([]byte("not a database")); err == nil {
		t.Error("Open accepted garbage")
	}
	city := geoiptest.Write("GeoLite2-ASN", testBuilt, geoiptest.N("81.0.0.0/8", "DE"))
	if _, err := Open(city); err == nil || !strings.Contains(err.Error(), "not a country database") {
		t.Errorf("Open(ASN database) err = %v", err)
	}
	data := geoiptest.Write("DBIP-Country-Lite", testBuilt, geoiptest.N("81.0.0.0/8", "DE"))
	// Break the search tree: point the root's left record past the data.
	broken := append([]byte(nil), data...)
	broken[0], broken[1], broken[2] = 0xff, 0xff, 0xf0
	db, err := Open(broken)
	if err == nil {
		if err := db.Verify(); err == nil {
			t.Error("Verify accepted a broken search tree")
		}
	}
}

func TestCountryCode(t *testing.T) {
	for in, want := range map[string]string{"de": "DE", "De": "DE", "IL": "IL", "": "", "DEU": "", "D1": "", "é": ""} {
		got, ok := countryCode(in)
		if want == "" {
			if ok {
				t.Errorf("countryCode(%q) = %q, want none", in, got)
			}
			continue
		}
		if !ok || got != want {
			t.Errorf("countryCode(%q) = %q, %v, want %q", in, got, ok, want)
		}
	}
}

// BenchmarkCountry is the in-memory lookup forwardAuth waits for.
func BenchmarkCountry(b *testing.B) {
	db, err := Open(geoiptest.Write("DBIP-Country-Lite", testBuilt, testNetworks...))
	if err != nil {
		b.Fatal(err)
	}
	ip := netip.MustParseAddr("88.214.55.20")
	b.ReportAllocs()
	for b.Loop() {
		if db.Country(ip) != "IL" {
			b.Fatal("wrong country")
		}
	}
}

func mustAddr(s string) netip.Addr { return netip.MustParseAddr(s) }
