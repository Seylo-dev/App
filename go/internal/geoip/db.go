package geoip

import (
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"strings"
	"time"

	"github.com/oschwald/maxminddb-golang/v2"

	"github.com/seylo-dev/app/go/gen/brand"
)

// Header is the request header apps get.
const Header = "X-" + brand.DisplayName + "-Country"

// Unknown is the header's value when the country is not known: a private
// or reserved address, an address the database has no country for, or no
// database yet.
const Unknown = "XX"

// MaxDatabaseSize bounds a database file (DB-IP's country file is about
// 8 MB, GeoLite2 Country about 10 MB).
const MaxDatabaseSize = 128 << 20

// DB is a country database in memory. Lookups are safe for concurrent use.
type DB struct {
	r    *maxminddb.Reader
	info DBInfo
}

// DBInfo describes a loaded database.
type DBInfo struct {
	// Type is the file's database_type, for example "DBIP-Country-Lite" or
	// "GeoLite2-Country".
	Type string `json:"type"`
	// Built is when the provider built it.
	Built time.Time `json:"built"`
	// Size is the file's size in bytes.
	Size int `json:"size"`
}

// Open reads a database from data, which it keeps (do not change it). It
// checks that it is a country database with IPv6 and IPv4 networks.
func Open(data []byte) (*DB, error) {
	if len(data) > MaxDatabaseSize {
		return nil, fmt.Errorf("the country database is %d bytes, more than the %d allowed", len(data), MaxDatabaseSize)
	}
	r, err := maxminddb.OpenBytes(data)
	if err != nil {
		return nil, fmt.Errorf("reading the country database: %w", err)
	}
	m := r.Metadata
	if !strings.Contains(strings.ToLower(m.DatabaseType), "country") {
		return nil, fmt.Errorf("the database is of type %q, not a country database", m.DatabaseType)
	}
	if m.IPVersion != 6 {
		return nil, errors.New("the country database has no IPv6 networks")
	}
	return &DB{r: r, info: DBInfo{Type: m.DatabaseType, Built: m.BuildTime().UTC(), Size: len(data)}}, nil
}

// Verify walks the whole database (search tree and data), for a file just
// downloaded: Open only reads its metadata.
func (db *DB) Verify() error {
	if err := db.r.Verify(); err != nil {
		return fmt.Errorf("checking the country database: %w", err)
	}
	return nil
}

// Info describes the database.
func (db *DB) Info() DBInfo { return db.info }

// Country is ip's ISO 3166-1 alpha-2 code in upper case, or Unknown. The
// network's country first, else the country it is registered in.
func (db *DB) Country(ip netip.Addr) string {
	if db == nil || !ip.IsValid() {
		return Unknown
	}
	ip = ip.Unmap().WithZone("")
	if !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return Unknown
	}
	res := db.r.Lookup(ip)
	if !res.Found() {
		return Unknown
	}
	var rec struct {
		Country struct {
			ISOCode string `maxminddb:"iso_code"`
		} `maxminddb:"country"`
		Registered struct {
			ISOCode string `maxminddb:"iso_code"`
		} `maxminddb:"registered_country"`
	}
	if err := res.Decode(&rec); err != nil {
		return Unknown
	}
	if code, ok := countryCode(rec.Country.ISOCode); ok {
		return code
	}
	if code, ok := countryCode(rec.Registered.ISOCode); ok {
		return code
	}
	return Unknown
}

// countryCode is s in upper case when it is two ASCII letters.
func countryCode(s string) (string, bool) {
	if len(s) != 2 {
		return "", false
	}
	b := []byte{s[0], s[1]}
	for i, c := range b {
		switch {
		case c >= 'a' && c <= 'z':
			b[i] = c - 'a' + 'A'
		case c >= 'A' && c <= 'Z':
		default:
			return "", false
		}
	}
	return string(b), true
}

// HeaderPattern matches Header and every alias of it, case-insensitively:
// the name with any other character than a letter, a digit or a dash
// between its words (X_Seylo_Country, X.Seylo.Country). CGI, PHP, WSGI and
// nginx read those as the same variable (HTTP_X_SEYLO_COUNTRY), so a
// client could slip one past a filter that only deletes Header.
// forwardAuth's authResponseHeadersRegex deletes every match from the
// request before it sets the server's Header.
var HeaderPattern = "(?i)^x[^a-z0-9]" + regexp.QuoteMeta(strings.ToLower(brand.DisplayName)) + "[^a-z0-9]country$"

// HeaderAliases are the spellings the strip-only middleware (the header
// off) deletes: Header with dashes or underscores between its words.
// Traefik's headers middleware deletes names, not patterns.
func HeaderAliases() []string {
	words := []string{"X", brand.DisplayName, "Country"}
	var out []string
	for _, a := range []string{"-", "_"} {
		for _, b := range []string{"-", "_"} {
			out = append(out, words[0]+a+words[1]+b+words[2])
		}
	}
	return out
}
