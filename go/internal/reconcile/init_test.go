package reconcile

import (
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// appSpec0213 is an app spec as a 0.2.13 panel sends it.
func appSpec0213() *agentv1.ServiceSpec {
	return &agentv1.ServiceSpec{
		Id: "svc00000000000001", ProjectId: "prj00000000000001", Name: "api",
		Kind: agentv1.ServiceKind_SERVICE_KIND_APP, Generation: 7,
		Image: &agentv1.ImageRef{Reference: "ghcr.io/acme/api:1", Digest: "sha256:5f1d0e8c2a7b4e6f9a3c1d2e4b6a8c0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c"},
		Container: &agentv1.ContainerConfig{
			Command: []string{"bun", "run", "start"}, StopSignal: "SIGTERM", StopGracePeriod: durationpb.New(10 * time.Second),
		},
		Env:   []*agentv1.EnvVar{{Name: "PORT", Value: "3000"}},
		Ports: []*agentv1.PortSpec{{ContainerPort: 3000, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_TCP}},
	}
}

// A spec without an init mode hashes exactly as under 0.2.13 (the value
// below came from the tree before the field), so the containers it runs
// are adopted as they are after an agent update. A mode is part of the
// hash: it applies from the next deploy, with new containers.
func TestInitModeSpecHash(t *testing.T) {
	const golden0213 = "3b1bd366f2c9c927"
	if got := SpecHash(appSpec0213()); got != golden0213 {
		t.Fatalf("SpecHash = %s, want the 0.2.13 value %s", got, golden0213)
	}
	seen := map[string]agentv1.InitMode{golden0213: agentv1.InitMode_INIT_MODE_UNSPECIFIED}
	for _, mode := range []agentv1.InitMode{agentv1.InitMode_INIT_MODE_AUTO, agentv1.InitMode_INIT_MODE_ON, agentv1.InitMode_INIT_MODE_OFF} {
		s := appSpec0213()
		s.Container.Init = mode
		h := SpecHash(s)
		if other, dup := seen[h]; dup {
			t.Fatalf("%v hashes like %v", mode, other)
		}
		seen[h] = mode
	}
}

// An agent before 0.2.15 keeps a new panel's init mode as an unknown field
// of ContainerConfig and hashes it at the end of the message; after its
// update it knows the field, which encodes at the same place. The hash
// stays, so the containers the old agent made are adopted, without init
// until the next deploy.
func TestInitModeHashFromAnOlderAgent(t *testing.T) {
	newer := appSpec0213()
	newer.Container.Init = agentv1.InitMode_INIT_MODE_AUTO
	older := appSpec0213()
	older.Container.ProtoReflect().SetUnknown(protowire.AppendVarint(protowire.AppendTag(nil, 7, protowire.VarintType), uint64(agentv1.InitMode_INIT_MODE_AUTO)))
	if SpecHash(older) != SpecHash(newer) {
		t.Fatalf("hash as an older agent kept it %s, after its update %s", SpecHash(older), SpecHash(newer))
	}
}

func initState(c *bool) string {
	switch {
	case c == nil:
		return "daemon default"
	case *c:
		return "on"
	}
	return "off"
}

// Containers get Docker's init by the spec's mode; Auto leaves it off for
// an image that runs its own init as PID 1 (s6-overlay's /init).
func TestContainersRunWithInit(t *testing.T) {
	h := newHarness(t)
	h.eng.Images["lsio/app:1"] = docker.Image{Entrypoint: []string{"/init"}}
	h.eng.Images["tini/app:1"] = docker.Image{Entrypoint: []string{"/sbin/tini", "--"}, Cmd: []string{"node", "server.js"}}
	cases := []struct {
		id, image string
		mode      agentv1.InitMode
		want      string
	}{
		{"before", "app:1", agentv1.InitMode_INIT_MODE_UNSPECIFIED, "daemon default"},
		{"auto", "app:1", agentv1.InitMode_INIT_MODE_AUTO, "on"},
		{"s6", "lsio/app:1", agentv1.InitMode_INIT_MODE_AUTO, "off"},
		{"tini", "tini/app:1", agentv1.InitMode_INIT_MODE_AUTO, "off"},
		{"forced", "lsio/app:1", agentv1.InitMode_INIT_MODE_ON, "on"},
		{"off", "app:1", agentv1.InitMode_INIT_MODE_OFF, "off"},
	}
	for i, c := range cases {
		s := appSpec(c.id, 1, c.image)
		s.Container = &agentv1.ContainerConfig{Init: c.mode}
		h.apply(uint64(i+1), s)
		if p := h.deployResult(c.id, 1); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
			t.Fatalf("%s: %v", c.id, p)
		}
		got, ok := h.eng.Get(docker.ContainerName(c.id, 1, 0))
		if !ok {
			t.Fatalf("%s: no container", c.id)
		}
		if initState(got.Spec.Init) != c.want {
			t.Errorf("%s: init %s, want %s", c.id, initState(got.Spec.Init), c.want)
		}
	}

	// A replica added later at the same generation gets the same.
	s := appSpec("s6", 2, "lsio/app:1")
	s.Container = &agentv1.ContainerConfig{Init: agentv1.InitMode_INIT_MODE_AUTO}
	s.Replicas = 2
	h.apply(uint64(len(cases)+1), s)
	h.waitFor("second replica", func() bool { _, ok := h.eng.Get(docker.ContainerName("s6", 1, 1)); return ok })
	if got, _ := h.eng.Get(docker.ContainerName("s6", 1, 1)); initState(got.Spec.Init) != "off" {
		t.Fatalf("replica init %s", initState(got.Spec.Init))
	}
}

// An agent restart adopts running containers whatever their init: neither
// a spec from before (no mode) nor one with a mode makes new containers.
func TestInitAdoptionAfterAgentRestart(t *testing.T) {
	h := newHarness(t)
	old := appSpec("old", 1, "app:1")
	auto := appSpec("auto", 1, "app:1")
	auto.Container = &agentv1.ContainerConfig{Init: agentv1.InitMode_INIT_MODE_AUTO}
	h.apply(1, old)
	h.apply(2, auto)
	h.deployResult("old", 1)
	h.deployResult("auto", 1)
	creates := h.eng.CallCount("CreateContainer")
	h.stop()
	h.start()
	h.apply(3, old)
	h.apply(4, auto)
	if got := h.eng.CallCount("CreateContainer"); got != creates {
		t.Fatalf("the restart made %d new containers", got-creates)
	}
	for _, id := range []string{"old", "auto"} {
		if got := h.running(id); len(got) != 1 || got[0] != docker.ContainerName(id, 1, 0) {
			t.Fatalf("%s running = %v", id, got)
		}
	}
}
