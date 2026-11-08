package tailnet

import "testing"

func TestVersion(t *testing.T) {
	for _, tc := range []struct {
		in, short string
		ok        bool
	}{
		{"1.104.4", "1.104.4", true},
		{"1.104.5-t2c6a4f1e8-g9b1d2c3e4", "1.104.5", true},
		{"1.104.3", "1.104.3", false},
		{"1.102.9", "1.102.9", false},
		{"1.98.9-t1234567ab-gabcdef012", "1.98.9", false},
		{"1.105.40-dev20261101", "1.105.40", true},
		{"1.110", "1.110", true},
		{"2.0.0", "2.0.0", true},
		{"v1.104.4", "1.104.4", true},
		{"0.99.1", "0.99.1", false},
		{"", "", false},
		{"unknown", "unknown", false},
		{"1.x.4", "1.x.4", false},
	} {
		if got := ShortVersion(tc.in); got != tc.short {
			t.Errorf("ShortVersion(%q) = %q, want %q", tc.in, got, tc.short)
		}
		if got := VersionOK(tc.in); got != tc.ok {
			t.Errorf("VersionOK(%q) = %v, want %v", tc.in, got, tc.ok)
		}
	}
}
