package logs

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/seylo-dev/app/go/internal/docker"
)

const labelService = docker.LabelService

func generationOf(labels map[string]string) uint64 {
	g, _ := strconv.ParseUint(labels[docker.LabelGeneration], 10, 64)
	return g
}

// cursorFile remembers, per container, the timestamp of the last captured
// line. It is saved every few seconds; after a crash at most those seconds
// of lines are captured twice.
type cursorFile struct {
	path string

	mu    sync.Mutex
	at    map[string]int64 // container id -> unix nanos
	dirty bool
}

func newCursorFile(path string) *cursorFile {
	return &cursorFile{path: path, at: map[string]int64{}}
}

func (c *cursorFile) load() error {
	b, err := os.ReadFile(c.path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	at := map[string]int64{}
	if err := json.Unmarshal(b, &at); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, t := range at {
		if t > c.at[id] {
			c.at[id] = t
		}
	}
	return nil
}

func (c *cursorFile) get(id string) time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	if t, ok := c.at[id]; ok {
		return time.Unix(0, t)
	}
	return time.Time{}
}

func (c *cursorFile) set(id string, t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if n := t.UnixNano(); n > c.at[id] {
		c.at[id] = n
		c.dirty = true
	}
}

func (c *cursorFile) forget(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.at[id]; ok {
		delete(c.at, id)
		c.dirty = true
	}
}

// retain drops cursors of containers that no longer exist.
func (c *cursorFile) retain(ids map[string]bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id := range c.at {
		if !ids[id] {
			delete(c.at, id)
			c.dirty = true
		}
	}
}

// save writes the file atomically when something changed.
func (c *cursorFile) save() error {
	c.mu.Lock()
	if !c.dirty {
		c.mu.Unlock()
		return nil
	}
	b, err := json.Marshal(c.at)
	c.dirty = false
	c.mu.Unlock()
	if err == nil {
		err = writeAtomic(c.path, b)
	}
	if err != nil {
		c.mu.Lock()
		c.dirty = true
		c.mu.Unlock()
	}
	return err
}

func writeAtomic(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
