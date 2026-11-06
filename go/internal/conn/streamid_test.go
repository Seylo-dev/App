package conn

import (
	"errors"
	"math"
	"testing"
)

func TestStreamIDParity(t *testing.T) {
	dialer, acceptor := NewStreamIDs(RoleDialer), NewStreamIDs(RoleAcceptor)
	for i := range 3 {
		d, err := dialer.Next()
		if err != nil {
			t.Fatal(err)
		}
		a, err := acceptor.Next()
		if err != nil {
			t.Fatal(err)
		}
		if want := StreamID(2*i + 1); d != want {
			t.Errorf("dialer id %d = %d, want %d", i, d, want)
		}
		if want := StreamID(2*i + 2); a != want {
			t.Errorf("acceptor id %d = %d, want %d", i, a, want)
		}
		if role, _ := OpenedBy(d); role != RoleDialer {
			t.Errorf("OpenedBy(%d) = %v", d, role)
		}
		if role, _ := OpenedBy(a); role != RoleAcceptor {
			t.Errorf("OpenedBy(%d) = %v", a, role)
		}
	}
	if _, ok := OpenedBy(ConnectionStream); ok {
		t.Error("stream 0 must belong to neither side")
	}
}

func TestStreamIDsExhaust(t *testing.T) {
	ids := &StreamIDs{next: math.MaxUint32}
	id, err := ids.Next()
	if err != nil || id != math.MaxUint32 {
		t.Fatalf("last id = %d, %v", id, err)
	}
	if _, err := ids.Next(); !errors.Is(err, ErrStreamIDsExhausted) {
		t.Fatalf("err = %v, want ErrStreamIDsExhausted", err)
	}
}
