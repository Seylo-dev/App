package agent

import (
	"testing"

	"github.com/seylo-dev/app/go/internal/portgate"
)

// Reconcile tells the portgate about deploy switches through a type
// assertion on its Gate (reconcile/rollout.go gateSwitched). d.Gate is the
// network wiring's networkParts, which must keep the Manager's Switched,
// or the IP:port relay goes back to dialing removed containers.
func TestNetworkGateHearsDeploySwitches(t *testing.T) {
	m := portgate.New(portgate.Config{})
	defer m.Close()
	var gate portgate.Gate = &networkParts{Manager: m}
	if _, ok := gate.(interface{ Switched(serviceID string) }); !ok {
		t.Fatal("d.Gate has no Switched: reconcile cannot tell the portgate that a deploy moved the route")
	}
}
