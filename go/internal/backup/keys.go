package backup

import (
	"errors"
	"fmt"
	"path"
	"regexp"
	"slices"
	"strings"
	"time"
)

// Object formats, recognised by key extension. The order matters for
// matching: longer extensions first.
const (
	extVolume   = ".tar.gz"
	extPgCustom = ".dump"
	extSQL      = ".sql.gz"
	extMongo    = ".archive.gz"
	extRedis    = ".rdb.gz"
)

var knownExts = []string{extVolume, extSQL, extMongo, extRedis, extPgCustom}

// formatOf returns the extension of a key we wrote, or "" for a key we
// did not.
func formatOf(key string) string {
	for _, e := range knownExts {
		if strings.HasSuffix(key, e) {
			return e
		}
	}
	return ""
}

// ErrBadRequest means a request is malformed (bad ids, missing fields).
var ErrBadRequest = errors.New("invalid backup request")

var segmentRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// timeLayout sorts lexicographically in time order, which retention
// relies on.
const timeLayout = "20060102T150405Z"

// backupDir is the folder of one backup's objects:
// <prefix>/<service_id>/<backup_id>/ (always ending in "/").
func backupDir(prefix, serviceID, backupID string) (string, error) {
	if !segmentRe.MatchString(serviceID) {
		return "", fmt.Errorf("%w: service id %q", ErrBadRequest, serviceID)
	}
	if !segmentRe.MatchString(backupID) {
		return "", fmt.Errorf("%w: backup id %q", ErrBadRequest, backupID)
	}
	p := strings.Trim(prefix, "/")
	if strings.Contains(p, "..") {
		return "", fmt.Errorf("%w: prefix %q", ErrBadRequest, prefix)
	}
	return path.Join(p, serviceID, backupID) + "/", nil
}

// objectKey is the key of one run's object.
func objectKey(dir, runID string, at time.Time, ext string) (string, error) {
	if !segmentRe.MatchString(runID) {
		return "", fmt.Errorf("%w: run id %q", ErrBadRequest, runID)
	}
	return dir + at.UTC().Format(timeLayout) + "-" + runID + ext, nil
}

// expired picks the objects retention deletes: everything we wrote directly
// in dir except the newest keep. Objects in sub-folders or with names we
// do not recognise are never touched. keep 0 deletes nothing.
func expired(dir string, keys []string, keep int) []string {
	if keep <= 0 {
		return nil
	}
	var ours []string
	for _, k := range keys {
		name, ok := strings.CutPrefix(k, dir)
		if !ok || strings.Contains(name, "/") || formatOf(name) == "" || len(name) < len(timeLayout) {
			continue
		}
		if _, err := time.Parse(timeLayout, name[:len(timeLayout)]); err != nil {
			continue
		}
		ours = append(ours, k)
	}
	if len(ours) <= keep {
		return nil
	}
	slices.Sort(ours)
	return ours[:len(ours)-keep]
}
