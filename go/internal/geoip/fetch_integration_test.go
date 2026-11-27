//go:build integration

package geoip

// The real download in the test VM: DB-IP's file of this month (or last
// month's), through the same client nodes use, checked and installed, and
// a few well-known addresses looked up in it.
//
//	SEYLO_IT_GEOIP_DOWNLOAD=1 scripts/dev/vm-gotest.sh ./internal/geoip -run IntegrationRealDownload -v

import (
	"context"
	"net/netip"
	"os"
	"testing"
	"time"
)

func TestIntegrationRealDownload(t *testing.T) {
	if os.Getenv("SEYLO_IT") != "1" || os.Getenv("SEYLO_IT_GEOIP_DOWNLOAD") != "1" {
		t.Skip("downloads DB-IP's database: SEYLO_IT_GEOIP_DOWNLOAD=1 scripts/dev/vm-gotest.sh")
	}
	f := &Fetcher{Dir: t.TempDir(), UserAgent: "seylo-agent-integration-test"}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	start := time.Now()
	updated, err := f.Refresh(ctx, MaxMind{})
	if err != nil || !updated {
		t.Fatalf("Refresh = %v, %v", updated, err)
	}
	st, _ := f.State()
	t.Logf("installed %s %s (%s, built %s) in %s", st.Source, st.Month, st.Type, st.Built.Format(time.DateOnly), time.Since(start).Round(time.Millisecond))
	db, err := readDB(f.Path())
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("database: %d bytes, %d search tree nodes", db.Info().Size, db.r.Metadata.NodeCount)
	for ip, want := range map[string]string{"8.8.8.8": "US", "2001:4860:4860::8888": "", "88.214.55.20": "", "1.1.1.1": "", "81.2.69.142": "", "10.0.0.1": Unknown} {
		got := db.Country(netip.MustParseAddr(ip))
		t.Logf("%s -> %s", ip, got)
		if want != "" && got != want {
			t.Errorf("%s: %s, want %s", ip, got, want)
		}
		if got != Unknown && len(got) != 2 {
			t.Errorf("%s: %q is no country code", ip, got)
		}
	}
	start = time.Now()
	ip := netip.MustParseAddr("88.214.55.20")
	for range 100000 {
		db.Country(ip)
	}
	t.Logf("lookup: %s each", time.Since(start)/100000)
}
