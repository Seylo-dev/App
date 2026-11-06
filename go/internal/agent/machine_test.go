package agent

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestPrivateAddressNeverLoopbackOrPublic(t *testing.T) {
	for _, u := range []string{"http://127.0.0.1:3000", "https://panel.invalid", "not a url", "http://10.0.0.1:3000"} {
		got := privateAddress(u)
		if got == "" {
			continue
		}
		ip := net.ParseIP(got).To4()
		if ip == nil || ip.IsLoopback() || !(ip.IsPrivate() || isSharedOrReserved(ip)) {
			t.Errorf("privateAddress(%q) = %q, want a private IPv4 or empty", u, got)
		}
	}
}

func TestTimeZoneName(t *testing.T) {
	dir := t.TempDir()
	zoneinfo := filepath.Join(dir, "usr/share/zoneinfo/Europe")
	if err := os.MkdirAll(zoneinfo, 0o755); err != nil {
		t.Fatal(err)
	}
	berlin := filepath.Join(zoneinfo, "Berlin")
	if err := os.WriteFile(berlin, []byte("TZif"), 0o644); err != nil {
		t.Fatal(err)
	}
	linked := filepath.Join(dir, "linked")
	if err := os.Symlink(berlin, linked); err != nil {
		t.Fatal(err)
	}
	copied := filepath.Join(dir, "copied")
	if err := os.WriteFile(copied, []byte("TZif"), 0o644); err != nil {
		t.Fatal(err)
	}
	timezone := filepath.Join(dir, "timezone")
	if err := os.WriteFile(timezone, []byte("Asia/Jerusalem\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(dir, "missing")
	for _, c := range []struct {
		name            string
		tz              string
		tzSet           bool
		localtime, file string
		want            string
	}{
		{"TZ wins", "America/New_York", true, linked, timezone, "America/New_York"},
		{"TZ with a colon", ":Asia/Tokyo", true, linked, timezone, "Asia/Tokyo"},
		{"empty TZ is UTC", "", true, linked, timezone, "UTC"},
		{"TZ as a zoneinfo path", berlin, true, missing, missing, "Europe/Berlin"},
		{"linked localtime", "", false, linked, timezone, "Europe/Berlin"},
		{"copied localtime with /etc/timezone", "", false, copied, timezone, "Asia/Jerusalem"},
		{"copied localtime without a name", "", false, copied, missing, ""},
		{"no localtime is UTC", "", false, missing, timezone, "UTC"},
	} {
		if got := timeZoneName(c.tz, c.tzSet, c.localtime, c.file); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
