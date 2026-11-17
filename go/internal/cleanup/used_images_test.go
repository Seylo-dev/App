package cleanup

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The record survives a restart, keeps the latest use per service,
// forgets images that are gone and starts over from a broken file.
func TestUsedImagesRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "used-images.json")
	t1 := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	t2 := t1.Add(time.Hour)

	u := NewUsedImages(path, nil)
	u.Record(t2, Use{Service: "db", Image: "img-a"}, Use{Service: "web", Image: "img-a"}, Use{Service: "db", Image: "img-b"})
	u.Record(t1, Use{Service: "db", Image: "img-a"})                             // older: ignored
	u.Record(t2, Use{Service: "", Image: "img-c"}, Use{Service: "x", Image: ""}) // incomplete: ignored

	again := NewUsedImages(path, nil).Snapshot()
	if len(again) != 2 || !again["img-a"]["db"].Equal(t2) || !again["img-a"]["web"].Equal(t2) || !again["img-b"]["db"].Equal(t2) {
		t.Fatalf("after a restart = %v", again)
	}

	u.Retain(map[string]bool{"img-b": true})
	if got := NewUsedImages(path, nil).Snapshot(); len(got) != 1 || got["img-b"] == nil {
		t.Fatalf("after Retain = %v", got)
	}

	// A snapshot is a copy.
	snap := u.Snapshot()
	snap["img-b"]["db"] = t1
	if !u.Snapshot()["img-b"]["db"].Equal(t2) {
		t.Fatal("a snapshot changed the record")
	}

	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	broken := NewUsedImages(path, nil)
	if got := broken.Snapshot(); len(got) != 0 {
		t.Fatalf("a broken file = %v", got)
	}
	broken.Record(t1, Use{Service: "db", Image: "img-d"})
	if got := NewUsedImages(path, nil).Snapshot(); len(got) != 1 || got["img-d"] == nil {
		t.Fatalf("written over the broken file = %v", got)
	}

	// Without a path it lives in memory; a nil record does nothing.
	mem := NewUsedImages("", nil)
	mem.Record(t1, Use{Service: "db", Image: "img-e"})
	if mem.Snapshot()["img-e"] == nil {
		t.Fatal("in-memory record lost a use")
	}
	var none *UsedImages
	none.Record(t1, Use{Service: "db", Image: "img-f"})
	none.Retain(nil)
	if none.Snapshot() != nil {
		t.Fatal("nil record returned data")
	}
}
