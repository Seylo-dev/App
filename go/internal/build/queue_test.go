package build

import (
	"context"
	"testing"
	"time"
)

func TestQueueLimitsAndOrder(t *testing.T) {
	q := NewQueue(1)
	ctx := context.Background()
	r1, err := q.Acquire(ctx, func(n int) {
		if n != 0 {
			t.Errorf("first build sees %d ahead", n)
		}
	})
	if err != nil {
		t.Fatal(err)
	}

	got := make(chan int, 2)
	for i := 1; i <= 2; i++ {
		ahead := make(chan int, 1)
		go func() {
			r, err := q.Acquire(ctx, func(n int) { ahead <- n })
			if err != nil {
				t.Error(err)
				return
			}
			got <- i
			r()
		}()
		if n := <-ahead; n != i {
			t.Fatalf("build %d sees %d ahead, want %d", i, n, i)
		}
	}
	select {
	case i := <-got:
		t.Fatalf("build %d started while the slot was taken", i)
	case <-time.After(50 * time.Millisecond):
	}
	r1()
	r1() // release is idempotent
	if a, b := <-got, <-got; a != 1 || b != 2 {
		t.Fatalf("started in order %d, %d", a, b)
	}
	if running, waiting := q.Stats(); running != 0 || waiting != 0 {
		t.Fatalf("stats %d running %d waiting", running, waiting)
	}
}

func TestQueueRaiseLimitStartsWaiters(t *testing.T) {
	q := NewQueue(1)
	ctx := context.Background()
	r1, _ := q.Acquire(ctx, nil)
	defer r1()
	started := make(chan func(), 1)
	go func() {
		r, err := q.Acquire(ctx, nil)
		if err == nil {
			started <- r
		}
	}()
	waitFor(t, func() bool { _, w := q.Stats(); return w == 1 })
	q.SetLimit(2)
	select {
	case r := <-started:
		r()
	case <-time.After(time.Second):
		t.Fatal("raising the limit did not start the waiting build")
	}
}

func TestQueueCancelWhileWaiting(t *testing.T) {
	q := NewQueue(1)
	r1, _ := q.Acquire(context.Background(), nil)
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() {
		_, err := q.Acquire(ctx, nil)
		errc <- err
	}()
	waitFor(t, func() bool { _, w := q.Stats(); return w == 1 })
	cancel()
	if err := <-errc; err == nil {
		t.Fatal("cancelled wait returned a slot")
	}
	if _, w := q.Stats(); w != 0 {
		t.Fatalf("%d still waiting after cancel", w)
	}
	r1()
	// The slot is free again.
	r2, err := q.Acquire(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	r2()
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
