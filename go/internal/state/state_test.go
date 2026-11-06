package state

import (
	"context"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func TestOutboxReporter(t *testing.T) {
	ctx := context.Background()
	out := NewMemoryOutbox()
	woken := 0
	r := &OutboxReporter{Outbox: out, Wake: func() { woken++ }}
	if err := r.Crash(ctx, &agentv1.CrashReport{ServiceId: "web"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Event(ctx, &agentv1.Event{Payload: &agentv1.Event_CronRun{CronRun: &agentv1.CronRun{RunId: "r1"}}}); err != nil {
		t.Fatal(err)
	}
	pending, _ := out.Pending(ctx, 0)
	if len(pending) != 2 || pending[0].ID != 1 || pending[0].Crash.GetServiceId() != "web" || pending[1].Event.GetTime() == nil {
		t.Fatalf("pending = %+v", pending)
	}
	if woken != 2 {
		t.Fatalf("woken %d times", woken)
	}
	if err := out.Ack(ctx, 1); err != nil {
		t.Fatal(err)
	}
	_ = out.Ack(ctx, 1) // a repeated ack is harmless
	if pending, _ := out.Pending(ctx, 1); len(pending) != 1 || pending[0].ID != 2 {
		t.Fatalf("after ack = %+v", pending)
	}
}

func TestDesiredFeed(t *testing.T) {
	f := NewDesiredFeed()
	var seen []uint64
	cancel := f.Subscribe(func(d *agentv1.DesiredState) {
		seen = append(seen, d.GetRevision())
		_ = f.Current() // allowed from a subscriber
	})
	f.Publish(&agentv1.DesiredState{Revision: 3, Settings: &agentv1.NodeSettings{GamesFirstCpu: true}})
	f.Publish(&agentv1.DesiredState{Revision: 2}) // older: ignored
	f.Publish(&agentv1.DesiredState{Revision: 3, Settings: &agentv1.NodeSettings{GamesFirstCpu: true}})
	cancel()
	f.Publish(&agentv1.DesiredState{Revision: 4})
	if len(seen) != 3 || seen[0] != 0 || seen[1] != 3 || seen[2] != 3 {
		t.Fatalf("seen = %v", seen)
	}
	if f.Current().GetRevision() != 4 || f.Settings().GetGamesFirstCpu() {
		t.Fatalf("current = %v", f.Current())
	}
}
