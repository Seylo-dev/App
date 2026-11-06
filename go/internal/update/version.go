package update

import (
	"strings"

	"golang.org/x/mod/semver"
)

// canonical turns "0.9.4" or "v0.9.4" into "v0.9.4"; it returns "" for
// anything that is not a semantic version (such as a "dev" build).
func canonical(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	if !strings.HasPrefix(v, "v") {
		v = "v" + v
	}
	if !semver.IsValid(v) {
		return ""
	}
	return v
}

// IsRelease reports whether v is a release version (not "dev").
func IsRelease(v string) bool { return canonical(v) != "" }

// Compare returns -1, 0 or 1 like strings.Compare. A version that is not
// semver (a "dev" build) sorts before every release.
func Compare(a, b string) int {
	ca, cb := canonical(a), canonical(b)
	switch {
	case ca == "" && cb == "":
		return 0
	case ca == "":
		return -1
	case cb == "":
		return 1
	}
	return semver.Compare(ca, cb)
}

// Newer reports whether candidate is a newer release than current.
func Newer(candidate, current string) bool {
	return IsRelease(candidate) && Compare(candidate, current) > 0
}
