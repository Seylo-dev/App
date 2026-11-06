package edge

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// sessionKeySize is the HMAC key length of tool session cookies.
const sessionKeySize = 32

// LoadSessionKey returns the tool session key kept at path, creating it
// (0600, in a 0700 folder) on first use. A file of the wrong size is
// replaced, which signs everyone out once.
func LoadSessionKey(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err == nil && len(b) == sessionKeySize {
		return b, nil
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("reading the edge session key: %w", err)
	}
	key := make([]byte, sessionKeySize)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("creating %s: %w", filepath.Dir(path), err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, key, 0o600); err != nil {
		return nil, fmt.Errorf("writing the edge session key: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return nil, fmt.Errorf("writing the edge session key: %w", err)
	}
	return key, nil
}
