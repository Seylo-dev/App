package reconcile

import (
	"context"
	"errors"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// bind_address is only for the protected panel service and only a
// loopback address; anything else is refused before it reaches Docker.
func TestValidateSpecBindAddress(t *testing.T) {
	for _, addr := range []string{"127.0.0.1", "127.0.0.53", "::1"} {
		s := panelSpec(1, "seylo:1")
		s.Ports[0].Public.BindAddress = addr
		if err := validateSpec(s); err != nil {
			t.Errorf("panel on %s: %v", addr, err)
		}
	}
	for _, addr := range []string{"0.0.0.0", "::", "203.0.113.5", "10.0.0.1", "localhost", "::ffff:127.0.0.1", "fe80::1%eth0", "127.0.0.1:3000", " 127.0.0.1"} {
		s := panelSpec(1, "seylo:1")
		s.Ports[0].Public.BindAddress = addr
		err := validateSpec(s)
		if !errors.Is(err, ErrInvalidSpec) || !strings.Contains(err.Error(), "loopback") {
			t.Errorf("panel on %q = %v, want refused as not loopback", addr, err)
		}
	}

	// Another service, protected or not, may not set it at all.
	for _, protected := range []bool{false, true} {
		s := appSpec("svc", 1, "app:v1")
		s.Protected = protected
		s.Ports[0].Public = &agentv1.PublicPort{HostPort: 8080, Mode: agentv1.PublicPortMode_PUBLIC_PORT_MODE_FORWARD, BindAddress: "127.0.0.1"}
		err := validateSpec(s)
		if !errors.Is(err, ErrInvalidSpec) || !strings.Contains(err.Error(), "only for the panel service") {
			t.Errorf("protected=%v service with a bind address = %v", protected, err)
		}
	}
	// The panel's id without protected is not the panel.
	s := panelSpec(1, "seylo:1")
	s.Protected = false
	s.Ports[0].Public.BindAddress = "127.0.0.1"
	if err := validateSpec(s); !errors.Is(err, ErrInvalidSpec) {
		t.Errorf("unprotected panel id with a bind address = %v", err)
	}
}

// A refused panel spec keeps the last valid one running: Apply answers
// INVALID_ARGUMENT and the container keeps its bindings.
func TestApplyRefusesBadBindAddress(t *testing.T) {
	h := newHarness(t)
	h.apply(1, panelSpec(1, "seylo:1"))
	h.deployResult(docker.PanelServiceID, 1)
	bad := panelSpec(2, "seylo:1")
	bad.Ports[0].Public.BindAddress = "203.0.113.5"
	if _, err := h.rt.Apply(context.Background(), 2, bad); !errors.Is(err, ErrInvalidSpec) {
		t.Fatalf("Apply = %v, want ErrInvalidSpec", err)
	}
	h.settle()
	c, ok := h.eng.Get(docker.ContainerName(docker.PanelServiceID, 1, 0))
	if !ok || !c.Running || len(c.Spec.Publish) != 1 || c.Spec.Publish[0].HostIP.IsValid() {
		t.Fatalf("panel after a refused spec = %+v", c.Spec.Publish)
	}
}
