//go:build integration

package docker

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// TestMobyConnectWhileRemovingIsErrRemoving connects a container to a
// network while Docker removes it, the race reconcile hits when Traefik is
// recreated: Docker answers a bare 500 "is marked for removal", which must
// come back as ErrRemoving. 20000 files in the container's layer keep the
// removal going for a while.
func TestMobyConnectWhileRemovingIsErrRemoving(t *testing.T) {
	m, prefix := itEngine(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	labels := map[string]string{"seylo.it": prefix}
	net := prefix + "-net"
	if err := m.EnsureNetwork(ctx, net, labels); err != nil {
		t.Fatal(err)
	}
	for round := range 3 {
		id, err := m.CreateContainer(ctx, ContainerSpec{
			Name:    prefix + "-rm" + itoa(round),
			Image:   testImage,
			Command: []string{"sh", "-c", "mkdir /d && cd /d && seq 1 20000 | xargs touch"},
			Labels:  labels,
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := m.StartContainer(ctx, id); err != nil {
			t.Fatal(err)
		}
		for {
			d, err := m.InspectContainer(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			if !d.Running {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		removed := make(chan error, 1)
		go func() { removed <- m.RemoveContainer(context.WithoutCancel(ctx), id) }()
		var cerr error
		for cerr == nil {
			cerr = m.ConnectNetwork(ctx, net, id, nil)
			time.Sleep(2 * time.Millisecond)
		}
		if err := <-removed; err != nil {
			t.Fatal(err)
		}
		if errors.Is(cerr, ErrNotFound) {
			t.Logf("round %d: the removal finished before a connect saw it: %v", round, cerr)
			continue
		}
		if !strings.Contains(cerr.Error(), "marked for removal") || !errors.Is(cerr, ErrRemoving) {
			t.Fatalf("connect during removal = %v, want ErrRemoving", cerr)
		}
		return
	}
	t.Fatal("no connect landed while the container was being removed")
}
