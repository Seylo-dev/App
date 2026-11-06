package state

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func TestFileDesiredStore(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state", "desired.pb")
	s := NewFileDesiredStore(path)
	d, err := s.Load(ctx)
	if err != nil || d.GetRevision() != 0 {
		t.Fatalf("empty load = %v, %v", d, err)
	}
	want := &agentv1.DesiredState{Revision: 5, Services: []*agentv1.ServiceSpec{{Id: "web"}}}
	if err := s.Save(ctx, want); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode())
	}
	got, err := NewFileDesiredStore(path).Load(ctx)
	if err != nil || got.GetRevision() != 5 || got.GetServices()[0].GetId() != "web" {
		t.Fatalf("reload = %v, %v", got, err)
	}
	if err := os.WriteFile(path, []byte{0xff, 0xff, 0xff}, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err = s.Load(ctx)
	if !errors.Is(err, ErrCorruptDesired) || got.GetRevision() != 0 {
		t.Fatalf("corrupt load = %v, %v", got, err)
	}
	if _, err := os.Stat(path + ".corrupt"); err != nil {
		t.Fatal("corrupt file not kept aside")
	}
}

func TestDesiredSyncRevisions(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "desired.pb")
	feed := NewDesiredFeed()
	var published []uint64
	feed.Subscribe(func(d *agentv1.DesiredState) { published = append(published, d.GetRevision()) })
	d := NewDesiredSync(NewFileDesiredStore(path), feed)

	rev, ok, err := d.Sync(ctx, &agentv1.DesiredState{Revision: 3, Services: []*agentv1.ServiceSpec{{Id: "a"}}})
	if err != nil || !ok || rev != 3 {
		t.Fatalf("sync = %d %v %v", rev, ok, err)
	}
	if rev, ok, _ := d.Apply(ctx, 2, &agentv1.ServiceSpec{Id: "b"}); ok || rev != 3 {
		t.Fatalf("old apply taken: %d %v", rev, ok)
	}
	if rev, ok, _ := d.Apply(ctx, 4, &agentv1.ServiceSpec{Id: "b"}); !ok || rev != 4 {
		t.Fatalf("apply = %d %v", rev, ok)
	}
	if _, _, err := d.Apply(ctx, 5, &agentv1.ServiceSpec{}); !errors.Is(err, ErrInvalidDesired) {
		t.Fatalf("apply without id = %v", err)
	}
	if _, ok, _ := d.Apply(ctx, 5, &agentv1.ServiceSpec{Id: "a", Generation: 2}); !ok {
		t.Fatal("replace not taken")
	}
	if _, ok, _ := d.Remove(ctx, 6, "b"); !ok {
		t.Fatal("remove not taken")
	}
	cur := d.Current()
	if cur.GetRevision() != 6 || len(cur.GetServices()) != 1 || cur.GetServices()[0].GetGeneration() != 2 {
		t.Fatalf("current = %v", cur)
	}
	if len(published) != 5 || published[len(published)-1] != 6 {
		t.Fatalf("published = %v", published)
	}

	// After a restart, Load publishes the stored state.
	feed2 := NewDesiredFeed()
	d2 := NewDesiredSync(NewFileDesiredStore(path), feed2)
	if err := d2.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if feed2.Current().GetRevision() != 6 || d2.Revision() != 6 {
		t.Fatalf("after restart = %v", feed2.Current())
	}
}

func TestMemoryStoreDeltas(t *testing.T) {
	s := NewMemoryStore()
	var deltas []*agentv1.StateDelta
	cancel := s.Subscribe(func(d *agentv1.StateDelta) { deltas = append(deltas, d) })
	s.SetService(&agentv1.ServiceStatus{ServiceId: "b", Phase: agentv1.ServicePhase_SERVICE_PHASE_RUNNING})
	s.SetService(&agentv1.ServiceStatus{ServiceId: "b", Phase: agentv1.ServicePhase_SERVICE_PHASE_RUNNING}) // same: no delta
	s.SetService(&agentv1.ServiceStatus{ServiceId: "a"})
	s.SetAppliedRevision(4)
	s.RemoveService("b")
	s.RemoveService("missing")
	cancel()
	s.SetAppliedRevision(5)

	if len(deltas) != 4 {
		t.Fatalf("deltas = %v", deltas)
	}
	for i, d := range deltas {
		if d.GetEpoch() != s.Epoch() || d.GetSeq() != uint64(i+1) {
			t.Fatalf("delta %d = %v", i, d)
		}
	}
	snap := s.Snapshot()
	if snap.GetSeq() != 5 || snap.GetAppliedRevision() != 5 || len(snap.GetServices()) != 1 || snap.GetServices()[0].GetServiceId() != "a" {
		t.Fatalf("snapshot = %v", snap)
	}
	if NewMemoryStore().Epoch() == s.Epoch() {
		t.Fatal("two stores share an epoch")
	}
}

func TestFileOutbox(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	o, err := OpenFileOutbox(dir, OutboxOptions{Now: zeroClock})
	if err != nil {
		t.Fatal(err)
	}
	id1, _ := o.AppendCrash(ctx, &agentv1.CrashReport{ServiceId: "web"})
	id2, _ := o.AppendEvent(ctx, &agentv1.Event{Payload: &agentv1.Event_CronRun{CronRun: &agentv1.CronRun{RunId: "r1"}}})
	if id1 != 1 || id2 != 2 {
		t.Fatalf("ids %d %d", id1, id2)
	}
	if err := o.Ack(ctx, 1); err != nil {
		t.Fatal(err)
	}

	// Reopen: the pending entry survives and ids keep increasing.
	o, err = OpenFileOutbox(dir, OutboxOptions{Now: zeroClock})
	if err != nil {
		t.Fatal(err)
	}
	pending, _ := o.Pending(ctx, 0)
	if len(pending) != 1 || pending[0].ID != 2 || pending[0].Event.GetCronRun().GetRunId() != "r1" {
		t.Fatalf("pending = %+v", pending)
	}
	_ = o.Ack(ctx, 2)
	o, _ = OpenFileOutbox(dir, OutboxOptions{Now: zeroClock})
	if id, _ := o.AppendEvent(ctx, &agentv1.Event{}); id != 3 {
		t.Fatalf("id after emptying and reopening = %d", id)
	}

	// A corrupt entry is dropped instead of blocking the queue.
	if err := os.WriteFile(filepath.Join(dir, "00000000000000000004.crash"), []byte{0xff, 0xff}, 0o600); err != nil {
		t.Fatal(err)
	}
	o, _ = OpenFileOutbox(dir, OutboxOptions{Now: zeroClock})
	pending, _ = o.Pending(ctx, 0)
	if len(pending) != 1 || pending[0].ID != 3 || o.Stats().Dropped != 1 {
		t.Fatalf("pending = %+v, stats %+v", pending, o.Stats())
	}
	if id, _ := o.AppendEvent(ctx, &agentv1.Event{}); id != 5 {
		t.Fatalf("id after a corrupt 4 = %d", id)
	}

	if _, err := o.AppendCrash(ctx, &agentv1.CrashReport{LastLines: []string{string(make([]byte, MaxOutboxEntryBytes))}}); !errors.Is(err, ErrOutboxEntryTooLarge) {
		t.Fatalf("huge report = %v", err)
	}
}

// zeroClock turns the time floor off, so ids count from 1.
func zeroClock() time.Time { return time.Unix(0, 0) }

// Restoring last week's copy of the data folder rolls "seq" back while the
// node keeps its identity; new ids must still be higher than every id the
// panel has stored, or it acks and drops the new reports as duplicates.
func TestFileOutboxIDsSurviveARestore(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	week := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	backup := t.TempDir()
	o, err := OpenFileOutbox(dir, OutboxOptions{Now: func() time.Time { return week }})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := o.AppendEvent(ctx, &agentv1.Event{}); err != nil {
		t.Fatal(err)
	}
	// The owner exports the folder now.
	seq, _ := os.ReadFile(filepath.Join(dir, "seq"))
	if err := os.WriteFile(filepath.Join(backup, "seq"), seq, 0o600); err != nil {
		t.Fatal(err)
	}
	// A week of reports the panel stores.
	o, _ = OpenFileOutbox(dir, OutboxOptions{Now: func() time.Time { return week.Add(time.Hour) }})
	var stored []uint64
	for range 50 {
		id, _ := o.AppendEvent(ctx, &agentv1.Event{})
		stored = append(stored, id)
		_ = o.Ack(ctx, id)
	}
	// Restore the old folder and start again a week later.
	restored := t.TempDir()
	if err := os.WriteFile(filepath.Join(restored, "seq"), seq, 0o600); err != nil {
		t.Fatal(err)
	}
	o, _ = OpenFileOutbox(restored, OutboxOptions{Now: func() time.Time { return week.Add(7 * 24 * time.Hour) }})
	id, _ := o.AppendEvent(ctx, &agentv1.Event{})
	if id <= slices.Max(stored) {
		t.Fatalf("id after the restore = %d, the panel already has up to %d", id, slices.Max(stored))
	}
}

func TestFileOutboxDropsOldest(t *testing.T) {
	ctx := context.Background()
	o, err := OpenFileOutbox(t.TempDir(), OutboxOptions{MaxEntries: 3, Now: zeroClock})
	if err != nil {
		t.Fatal(err)
	}
	for range 5 {
		if _, err := o.AppendCrash(ctx, &agentv1.CrashReport{ServiceId: "x"}); err != nil {
			t.Fatal(err)
		}
	}
	pending, _ := o.Pending(ctx, 2)
	if len(pending) != 2 || pending[0].ID != 3 || pending[1].ID != 4 {
		t.Fatalf("pending = %+v", pending)
	}
	if s := o.Stats(); s.Pending != 3 || s.Dropped != 2 || s.LastID != 5 {
		t.Fatalf("stats = %+v", s)
	}

	o, _ = OpenFileOutbox(t.TempDir(), OutboxOptions{MaxBytes: 100, Now: zeroClock})
	for range 10 {
		if _, err := o.AppendCrash(ctx, &agentv1.CrashReport{ServiceId: "0123456789012345678901234567890123456789"}); err != nil {
			t.Fatal(err)
		}
	}
	if s := o.Stats(); s.Bytes > 100 || s.Pending == 0 {
		t.Fatalf("byte bound broken: %+v", s)
	}
}
