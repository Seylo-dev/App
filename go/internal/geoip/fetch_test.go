package geoip

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/geoip/geoiptest"
)

// fakeProviders serves DB-IP's monthly files and MaxMind's archive.
type fakeProviders struct {
	mu       sync.Mutex
	months   map[string][]byte // month -> mmdb
	dbipDown bool
	maxmind  []byte // mmdb inside the archive; nil answers 404
	badSum   bool
	requests []string
	auth     []string
}

func (p *fakeProviders) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/free/", func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		defer p.mu.Unlock()
		p.requests = append(p.requests, r.URL.Path)
		if p.dbipDown {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		month := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/free/dbip-country-lite-"), ".mmdb.gz")
		data, ok := p.months[month]
		if !ok {
			http.NotFound(w, r)
			return
		}
		zw := gzip.NewWriter(w)
		_, _ = zw.Write(data)
		_ = zw.Close()
	})
	mux.HandleFunc("/geoip/databases/GeoLite2-Country/download", func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		defer p.mu.Unlock()
		p.requests = append(p.requests, r.URL.Path+"?"+r.URL.RawQuery)
		user, pass, _ := r.BasicAuth()
		p.auth = append(p.auth, user+":"+pass)
		if user != "123" || pass != "key" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if p.maxmind == nil {
			http.NotFound(w, r)
			return
		}
		archive := tarGz(p.maxmind)
		switch r.URL.Query().Get("suffix") {
		case "tar.gz.sha256":
			sum := sha256.Sum256(archive)
			if p.badSum {
				sum[0] ^= 1
			}
			fmt.Fprintf(w, "%s  GeoLite2-Country_20261124.tar.gz\n", hex.EncodeToString(sum[:]))
		case "tar.gz":
			_, _ = w.Write(archive)
		default:
			http.NotFound(w, r)
		}
	})
	return mux
}

func tarGz(mmdb []byte) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for _, f := range []struct {
		name string
		data []byte
	}{{"GeoLite2-Country_20261124/COPYRIGHT.txt", []byte("(c) MaxMind")}, {"GeoLite2-Country_20261124/GeoLite2-Country.mmdb", mmdb}} {
		_ = tw.WriteHeader(&tar.Header{Name: f.name, Mode: 0o644, Size: int64(len(f.data)), Typeflag: tar.TypeReg})
		_, _ = tw.Write(f.data)
	}
	_ = tw.Close()
	_ = zw.Close()
	return buf.Bytes()
}

func newTestFetcher(t *testing.T, p *fakeProviders, now time.Time) *Fetcher {
	t.Helper()
	srv := httptest.NewServer(p.handler())
	t.Cleanup(srv.Close)
	return &Fetcher{
		Dir:        t.TempDir(),
		Client:     srv.Client(),
		DBIPURL:    srv.URL + "/free/dbip-country-lite-%s.mmdb.gz",
		MaxMindURL: srv.URL + "/geoip/databases/GeoLite2-Country/download",
		MinNodes:   -1,
		Now:        func() time.Time { return now },
	}
}

func dbipFile(country string) []byte {
	return geoiptest.Write("DBIP-Country-Lite", testBuilt, geoiptest.N("88.214.55.0/24", country))
}

func installedCountry(t *testing.T, f *Fetcher) string {
	t.Helper()
	db, err := readDB(f.Path())
	if err != nil {
		t.Fatal(err)
	}
	return db.Country(mustAddr("88.214.55.20"))
}

func TestRefreshDBIP(t *testing.T) {
	p := &fakeProviders{months: map[string][]byte{"2026-11": dbipFile("IL")}}
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	f := newTestFetcher(t, p, now)
	if !f.Due() {
		t.Fatal("no database: not due")
	}
	updated, err := f.Refresh(context.Background(), MaxMind{})
	if err != nil || !updated {
		t.Fatalf("Refresh = %v, %v", updated, err)
	}
	if got := installedCountry(t, f); got != "IL" {
		t.Errorf("installed file says %q", got)
	}
	st, err := f.State()
	if err != nil {
		t.Fatal(err)
	}
	if st.Source != SourceDBIP || st.Month != "2026-11" || st.Type != "DBIP-Country-Lite" || len(st.SHA256) != 64 || !st.InstalledAt.Equal(now) {
		t.Errorf("state = %+v", st)
	}
	info, err := os.Stat(f.Path())
	if err != nil || info.Mode().Perm() != 0o644 {
		t.Errorf("file mode: %v %v (the lookup server reads it)", info.Mode(), err)
	}
	// Same month: nothing to do, no request.
	before := len(p.requests)
	if f.Due() {
		t.Error("due again in the same month")
	}
	if updated, err := f.Refresh(context.Background(), MaxMind{}); err != nil || updated {
		t.Errorf("second Refresh = %v, %v", updated, err)
	}
	if len(p.requests) != before {
		t.Errorf("second Refresh asked DB-IP: %v", p.requests[before:])
	}
}

func TestRefreshNewMonth(t *testing.T) {
	p := &fakeProviders{months: map[string][]byte{"2026-11": dbipFile("IL")}}
	now := time.Date(2026, 11, 30, 23, 0, 0, 0, time.UTC)
	f := newTestFetcher(t, p, now)
	if _, err := f.Refresh(context.Background(), MaxMind{}); err != nil {
		t.Fatal(err)
	}
	// December starts; DB-IP has not published yet: keep November, no
	// error, no MaxMind.
	now = time.Date(2026, 12, 1, 0, 30, 0, 0, time.UTC)
	f.Now = func() time.Time { return now }
	if !f.Due() {
		t.Fatal("new month: not due")
	}
	updated, err := f.Refresh(context.Background(), MaxMind{AccountID: "123", LicenseKey: "key"})
	if err != nil || updated {
		t.Fatalf("Refresh before the new file = %v, %v", updated, err)
	}
	for _, r := range p.requests {
		if strings.Contains(r, "GeoLite2") {
			t.Errorf("asked MaxMind while last month's DB-IP file is fine: %s", r)
		}
	}
	if got := installedCountry(t, f); got != "IL" {
		t.Errorf("installed file says %q", got)
	}
	// Published.
	p.mu.Lock()
	p.months["2026-12"] = dbipFile("CY")
	p.mu.Unlock()
	if updated, err := f.Refresh(context.Background(), MaxMind{}); err != nil || !updated {
		t.Fatalf("Refresh after the new file = %v, %v", updated, err)
	}
	if got := installedCountry(t, f); got != "CY" {
		t.Errorf("installed file says %q", got)
	}
}

func TestRefreshFirstDayTakesLastMonth(t *testing.T) {
	p := &fakeProviders{months: map[string][]byte{"2026-10": dbipFile("IL")}}
	f := newTestFetcher(t, p, time.Date(2026, 11, 1, 1, 0, 0, 0, time.UTC))
	if updated, err := f.Refresh(context.Background(), MaxMind{}); err != nil || !updated {
		t.Fatalf("Refresh = %v, %v", updated, err)
	}
	st, _ := f.State()
	if st.Month != "2026-10" {
		t.Errorf("month %q, want last month's", st.Month)
	}
	// Still due: this month's file comes later.
	if !f.Due() {
		t.Error("last month's file is not due for this month's")
	}
}

func TestRefreshFallsBackToMaxMind(t *testing.T) {
	p := &fakeProviders{dbipDown: true, maxmind: geoiptest.Write("GeoLite2-Country", testBuilt, geoiptest.N("88.214.55.0/24", "IL"))}
	f := newTestFetcher(t, p, time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC))

	// No account: DB-IP's error, nothing installed.
	updated, err := f.Refresh(context.Background(), MaxMind{})
	if err == nil || updated || !strings.Contains(err.Error(), "DB-IP") {
		t.Fatalf("Refresh without an account = %v, %v", updated, err)
	}
	if st, _ := f.State(); st.LastError == "" {
		t.Error("the failure is not in the state")
	}
	for _, r := range p.requests {
		if strings.Contains(r, "GeoLite2") {
			t.Errorf("asked MaxMind without an account: %s", r)
		}
	}

	updated, err = f.Refresh(context.Background(), MaxMind{AccountID: "123", LicenseKey: "key"})
	if err != nil || !updated {
		t.Fatalf("Refresh with an account = %v, %v", updated, err)
	}
	st, _ := f.State()
	if st.Source != SourceMaxMind || st.Type != "GeoLite2-Country" || st.LastError != "" {
		t.Errorf("state = %+v", st)
	}
	if got := installedCountry(t, f); got != "IL" {
		t.Errorf("installed file says %q", got)
	}
	for _, a := range p.auth {
		if a != "123:key" {
			t.Errorf("MaxMind got credentials %q", a)
		}
	}
	// A GeoLite2 file is due again after a week, and DB-IP goes first.
	f.Now = func() time.Time { return time.Date(2026, 12, 5, 12, 0, 0, 0, time.UTC) }
	if !f.Due() {
		t.Error("week-old GeoLite2 file: not due")
	}
	p.mu.Lock()
	p.dbipDown = false
	p.months = map[string][]byte{"2026-12": dbipFile("CY")}
	p.mu.Unlock()
	if updated, err := f.Refresh(context.Background(), MaxMind{AccountID: "123", LicenseKey: "key"}); err != nil || !updated {
		t.Fatalf("Refresh = %v, %v", updated, err)
	}
	if st, _ := f.State(); st.Source != SourceDBIP {
		t.Errorf("source %q, want DB-IP back", st.Source)
	}
}

func TestRefreshMaxMindRefusals(t *testing.T) {
	mm := geoiptest.Write("GeoLite2-Country", testBuilt, geoiptest.N("88.214.55.0/24", "IL"))
	p := &fakeProviders{dbipDown: true, maxmind: mm, badSum: true}
	f := newTestFetcher(t, p, time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC))
	if _, err := f.Refresh(context.Background(), MaxMind{AccountID: "123", LicenseKey: "key"}); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Errorf("bad checksum: %v", err)
	}
	p.badSum = false
	if _, err := f.Refresh(context.Background(), MaxMind{AccountID: "123", LicenseKey: "wrong"}); err == nil || !strings.Contains(err.Error(), "license key") {
		t.Errorf("wrong key: %v", err)
	}
	if _, err := os.Stat(f.Path()); err == nil {
		t.Error("a file was installed")
	}
}

func TestRefreshRefusesBadFiles(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	for name, data := range map[string][]byte{
		"not a database":  []byte("<html>maintenance</html>"),
		"not for country": geoiptest.Write("DBIP-ASN-Lite", testBuilt, geoiptest.N("88.214.55.0/24", "IL")),
	} {
		p := &fakeProviders{months: map[string][]byte{"2026-11": data}}
		f := newTestFetcher(t, p, now)
		if updated, err := f.Refresh(context.Background(), MaxMind{}); err == nil || updated {
			t.Errorf("%s: Refresh = %v, %v", name, updated, err)
		}
		if _, err := os.Stat(f.Path()); err == nil {
			t.Errorf("%s: installed", name)
		}
	}
	// A real database is large; a tiny one is refused unless the test
	// says otherwise.
	p := &fakeProviders{months: map[string][]byte{"2026-11": dbipFile("IL")}}
	f := newTestFetcher(t, p, now)
	f.MinNodes = 0
	if _, err := f.Refresh(context.Background(), MaxMind{}); err == nil || !strings.Contains(err.Error(), "search tree nodes") {
		t.Errorf("tiny database: %v", err)
	}
}

func TestRefreshKeepsInstalledFileOnFailure(t *testing.T) {
	p := &fakeProviders{months: map[string][]byte{"2026-10": dbipFile("IL")}}
	f := newTestFetcher(t, p, time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC))
	if _, err := f.Refresh(context.Background(), MaxMind{}); err != nil {
		t.Fatal(err)
	}
	f.Now = func() time.Time { return time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC) }
	p.mu.Lock()
	p.dbipDown = true
	p.mu.Unlock()
	if _, err := f.Refresh(context.Background(), MaxMind{}); err == nil {
		t.Error("DB-IP down: no error")
	}
	if got := installedCountry(t, f); got != "IL" {
		t.Errorf("installed file says %q", got)
	}
}
