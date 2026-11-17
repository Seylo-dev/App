package cleanup

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// UsedImages remembers which images each service's containers were made
// from. An image pulled from a registry carries no seylo label (labels
// are part of the image), so without this record the cleanup could not
// tell the old versions of a database's or an app's image from the
// images of other software on the node. The agent records an image when
// it creates a service's container from it (reconcile) and when a cleanup
// finds a service's container using it. The record lives in the state
// folder, so it survives restarts; images that are gone drop out of it.
type UsedImages struct {
	path string
	log  *slog.Logger

	mu     sync.Mutex
	loaded bool
	// images maps an image id to the services that used it, with the
	// last time each did.
	images map[string]map[string]time.Time
	// saveFailed keeps a failing disk from logging every write.
	saveFailed bool
}

// Use is one service using one image.
type Use struct {
	Service string
	Image   string
}

// usedImagesFile is the record's format on disk.
type usedImagesFile struct {
	Version int                             `json:"version"`
	Images  map[string]map[string]time.Time `json:"images"`
}

// NewUsedImages returns the record kept in path; an empty path keeps it
// in memory only (tests).
func NewUsedImages(path string, log *slog.Logger) *UsedImages {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &UsedImages{path: path, log: log}
}

// Record notes that each use's service used its image at t.
func (u *UsedImages) Record(t time.Time, uses ...Use) {
	if u == nil || len(uses) == 0 {
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	u.loadLocked()
	changed := false
	for _, use := range uses {
		if use.Service == "" || use.Image == "" {
			continue
		}
		services := u.images[use.Image]
		if services == nil {
			services = map[string]time.Time{}
			u.images[use.Image] = services
		}
		if last, ok := services[use.Service]; !ok || t.After(last) {
			services[use.Service] = t.UTC()
			changed = true
		}
	}
	if changed {
		u.saveLocked()
	}
}

// Retain forgets the images that are not in present (removed since).
func (u *UsedImages) Retain(present map[string]bool) {
	if u == nil {
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	u.loadLocked()
	changed := false
	for id := range u.images {
		if !present[id] {
			delete(u.images, id)
			changed = true
		}
	}
	if changed {
		u.saveLocked()
	}
}

// Snapshot returns a copy of the record: image id -> service -> last use.
func (u *UsedImages) Snapshot() map[string]map[string]time.Time {
	if u == nil {
		return nil
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	u.loadLocked()
	out := make(map[string]map[string]time.Time, len(u.images))
	for id, services := range u.images {
		out[id] = maps.Clone(services)
	}
	return out
}

func (u *UsedImages) loadLocked() {
	if u.loaded {
		return
	}
	u.loaded = true
	u.images = map[string]map[string]time.Time{}
	if u.path == "" {
		return
	}
	b, err := os.ReadFile(u.path)
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	var f usedImagesFile
	if err == nil {
		err = json.Unmarshal(b, &f)
	}
	if err != nil {
		// Starting over only means images used before stay until the
		// service uses another one.
		u.log.Warn("reading the record of images services used; starting a new one", "path", u.path, "err", err)
		return
	}
	for id, services := range f.Images {
		if len(services) > 0 {
			u.images[id] = services
		}
	}
}

func (u *UsedImages) saveLocked() {
	if u.path == "" {
		return
	}
	b, err := json.Marshal(usedImagesFile{Version: 1, Images: u.images})
	if err == nil {
		err = os.MkdirAll(filepath.Dir(u.path), 0o700)
	}
	if err == nil {
		tmp := u.path + ".tmp"
		if err = os.WriteFile(tmp, b, 0o600); err == nil {
			err = os.Rename(tmp, u.path)
		}
	}
	if err != nil {
		if !u.saveFailed {
			u.log.Warn("writing the record of images services used", "path", u.path, "err", err)
		}
		u.saveFailed = true
		return
	}
	u.saveFailed = false
}
