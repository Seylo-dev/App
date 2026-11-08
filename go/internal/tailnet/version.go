package tailnet

import (
	"strconv"
	"strings"
)

// MinVersion is the oldest tailscaled the agent serves the panel through
// (packages/ops tailscale.minTailscaleVersion). Unix socket Serve targets
// are older, but 1.104.4 fixes the Serve and SSH socket bulletins
// TS-2026-014 to TS-2026-017: unix backends re-checked on every dial, no
// TCP forward to tailscaled's own socket, no capability headers crossing
// mounts.
const MinVersion = "1.104.4"

// ShortVersion is the release part of tailscaled's long version:
// "1.104.5-t1a2b3c4d5-g6e7f8a9b0" is "1.104.5".
func ShortVersion(v string) string {
	v = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(v), "v"))
	if i := strings.IndexAny(v, "-+ "); i >= 0 {
		v = v[:i]
	}
	return v
}

// VersionOK reports whether tailscaled's version (short or long) is
// MinVersion or newer. An unreadable version is not.
func VersionOK(v string) bool {
	got, ok := parseVersion(ShortVersion(v))
	if !ok {
		return false
	}
	want, _ := parseVersion(MinVersion)
	for i := range got {
		if got[i] != want[i] {
			return got[i] > want[i]
		}
	}
	return true
}

func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	parts := strings.Split(v, ".")
	if len(parts) < 2 || len(parts) > 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
