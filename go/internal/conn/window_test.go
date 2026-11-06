package conn

import (
	"context"
	"errors"
	"math"
	"sync"
	"testing"
	"time"
)

func TestSendWindowTakesAvailableCredit(t *testing.T) {
	w := NewSendWindow(10)
	ctx := context.Background()

	n, err := w.Acquire(ctx, 4)
	if err != nil || n != 4 {
		t.Fatalf("Acquire(4) = %d, %v", n, err)
	}
	n, err = w.Acquire(ctx, 100)
	if err != nil || n != 6 {
		t.Fatalf("Acquire(100) with 6 left = %d, %v", n, err)
	}
	if w.Available() != 0 {
		t.Fatalf("Available = %d", w.Available())
	}
	if n, _ := w.Acquire(ctx, 0); n != 0 {
		t.Fatalf("Acquire(0) = %d", n)
	}
}

func TestSendWindowBlocksUntilGrant(t *testing.T) {
	w := NewSendWindow(0)
	got := make(chan int, 1)
	go func() {
		n, _ := w.Acquire(context.Background(), 8)
		got <- n
	}()

	select {
	case n := <-got:
		t.Fatalf("Acquire returned %d without credit", n)
	case <-time.After(20 * time.Millisecond):
	}

	if err := w.Grant(5); err != nil {
		t.Fatal(err)
	}
	select {
	case n := <-got:
		if n != 5 {
			t.Fatalf("Acquire after Grant(5) = %d", n)
		}
	case <-time.After(time.Second):
		t.Fatal("Acquire did not wake on Grant")
	}
}

func TestSendWindowWakesAllWaitersOnClose(t *testing.T) {
	w := NewSendWindow(0)
	reason := errors.New("stream reset")
	var wg sync.WaitGroup
	errs := make(chan error, 3)
	for range 3 {
		wg.Go(func() {
			_, err := w.Acquire(context.Background(), 1)
			errs <- err
		})
	}
	time.Sleep(10 * time.Millisecond)
	w.Close(reason)
	w.Close(errors.New("second close is ignored"))
	wg.Wait()
	close(errs)
	for err := range errs {
		if !errors.Is(err, reason) {
			t.Fatalf("waiter err = %v, want %v", err, reason)
		}
	}
	if err := w.Grant(10); err != nil {
		t.Fatalf("Grant after Close = %v, want nil", err)
	}
}

func TestSendWindowCloseNilReason(t *testing.T) {
	w := NewSendWindow(1)
	w.Close(nil)
	if _, err := w.Acquire(context.Background(), 1); !errors.Is(err, ErrWindowClosed) {
		t.Fatalf("err = %v", err)
	}
}

func TestSendWindowHonoursContext(t *testing.T) {
	w := NewSendWindow(0)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := w.Acquire(ctx, 1); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
}

func TestSendWindowRejectsOverflow(t *testing.T) {
	w := NewSendWindow(math.MaxInt32)
	if err := w.Grant(1); !errors.Is(err, ErrFlowControl) {
		t.Fatalf("err = %v, want ErrFlowControl", err)
	}
}

func TestRecvWindowEnforcesCredit(t *testing.T) {
	w := NewRecvWindow(100)
	if err := w.Receive(100); err != nil {
		t.Fatal(err)
	}
	if err := w.Receive(1); !errors.Is(err, ErrFlowControl) {
		t.Fatalf("err = %v, want ErrFlowControl", err)
	}
}

func TestRecvWindowBatchesGrants(t *testing.T) {
	w := NewRecvWindow(100)
	if err := w.Receive(100); err != nil {
		t.Fatal(err)
	}
	if inc := w.Consume(30); inc != 0 {
		t.Fatalf("grant after 30/100 consumed = %d, want 0", inc)
	}
	if inc := w.Consume(20); inc != 50 {
		t.Fatalf("grant at half window = %d, want 50", inc)
	}
	// The peer got 50 credits back, so 50 more bytes are fine and 51 are not.
	if err := w.Receive(50); err != nil {
		t.Fatal(err)
	}
	if err := w.Receive(1); !errors.Is(err, ErrFlowControl) {
		t.Fatalf("err = %v", err)
	}
	if inc := w.Consume(0); inc != 0 {
		t.Fatalf("Consume(0) = %d", inc)
	}
}

// TestWindowsTransferEverything connects a sender and a receiver through
// the two window halves, with the receiver consuming in smaller bites than
// the sender writes, and checks that every byte arrives without the sender
// ever exceeding its credit.
func TestWindowsTransferEverything(t *testing.T) {
	const window, total = 1024, 1 << 20
	send := NewSendWindow(window)
	recv := NewRecvWindow(window)
	chunks := make(chan int, total)
	grants := make(chan uint32, total)
	ctx := context.Background()

	go func() {
		for inc := range grants {
			if err := send.Grant(inc); err != nil {
				t.Error(err)
				return
			}
		}
	}()
	go func() {
		defer close(chunks)
		for sent := 0; sent < total; {
			n, err := send.Acquire(ctx, min(300, total-sent))
			if err != nil {
				t.Error(err)
				return
			}
			chunks <- n
			sent += n
		}
	}()

	received := 0
	for n := range chunks {
		if err := recv.Receive(n); err != nil {
			t.Fatalf("sender exceeded its credit after %d bytes: %v", received, err)
		}
		for left := n; left > 0; {
			bite := min(left, 100)
			left -= bite
			received += bite
			if inc := recv.Consume(bite); inc > 0 {
				grants <- inc
			}
		}
	}
	close(grants)
	if received != total {
		t.Fatalf("received %d of %d bytes", received, total)
	}
}
