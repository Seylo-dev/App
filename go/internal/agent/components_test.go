package agent

import (
	"context"
	"errors"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"
)

func TestComponentsRestartFailedLoops(t *testing.T) {
	saved := backoffMin
	backoffMin = time.Millisecond
	t.Cleanup(func() { backoffMin = saved })

	var c Components
	var flaky, done, panicky atomic.Int32
	c.Add("flaky", func(ctx context.Context) error {
		if flaky.Add(1) < 3 {
			return errors.New("transient")
		}
		<-ctx.Done()
		return nil
	})
	c.Add("done", func(context.Context) error {
		done.Add(1)
		return nil
	})
	c.Add("panicky", func(ctx context.Context) error {
		if panicky.Add(1) == 1 {
			panic("bug")
		}
		<-ctx.Done()
		return nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan struct{})
	go func() {
		c.run(ctx, slog.New(slog.DiscardHandler))
		close(finished)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for flaky.Load() < 3 || panicky.Load() < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("flaky ran %d times, panicky %d", flaky.Load(), panicky.Load())
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("components did not stop")
	}
	if done.Load() != 1 {
		t.Fatalf("a loop that returned nil ran %d times", done.Load())
	}
}

func TestConnectionHooks(t *testing.T) {
	var c Components
	var got ConnInfo
	var disconnected bool
	c.OnConnect(func(_ context.Context, info ConnInfo) { got = info })
	c.OnDisconnect(func() { disconnected = true })
	c.connected(context.Background(), ConnInfo{SessionID: "s1"})
	c.disconnected()
	if got.SessionID != "s1" || !disconnected {
		t.Fatalf("hooks: %+v %v", got, disconnected)
	}
}
