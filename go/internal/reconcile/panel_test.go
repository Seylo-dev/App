package reconcile

import (
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// panelSpec is what the panel sends for itself on its first join.
func panelSpec(gen uint64, image string) *agentv1.ServiceSpec {
	return &agentv1.ServiceSpec{
		Id: docker.PanelServiceID, ProjectId: docker.PanelProjectID, Name: "panel",
		Kind: agentv1.ServiceKind_SERVICE_KIND_APP, Generation: gen, Protected: true,
		Image: &agentv1.ImageRef{Reference: image},
		Env:   []*agentv1.EnvVar{{Name: "SEYLO_PORT", Value: "3000"}},
		Ports: []*agentv1.PortSpec{{ContainerPort: 3000, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_TCP,
			Public: &agentv1.PublicPort{HostPort: 3100, Mode: agentv1.PublicPortMode_PUBLIC_PORT_MODE_FORWARD}}},
		NetworkAliases: []string{"panel"},
		Deploy:         &agentv1.DeployStrategy{Mode: agentv1.DeployMode_DEPLOY_MODE_RECREATE},
	}
}

func TestInstallerPanelIsAdoptedWithoutARoll(t *testing.T) {
	h := newHarness(t)
	// The installer's container: reserved ids, generation 1, protected, no
	// spec hash, run as the panel user, the panel port published on every
	// address (cli.panelRunArgs).
	installer := addInstallerPanel(h, docker.PortPublish{HostPort: 3100, ContainerPort: 3000})

	h.apply(1, panelSpec(1, "seylo:1"))
	if got := h.names(docker.PanelServiceID); len(got) != 1 {
		t.Fatalf("panel containers = %v, want only the installer's", got)
	}
	if c, ok := h.eng.Get(installer); !ok || !c.Running {
		t.Fatal("the installer's panel was replaced")
	}
	h.waitFor("running", func() bool {
		return h.state.get(docker.PanelServiceID).GetPhase() == agentv1.ServicePhase_SERVICE_PHASE_RUNNING
	})

	// A later generation (an update or a settings change) rolls it the
	// normal way, with the panel's bind and Docker-published port.
	h.apply(2, panelSpec(2, "seylo:2"))
	h.deployResult(docker.PanelServiceID, 2)
	if _, ok := h.eng.Get(installer); ok {
		t.Fatal("the generation 1 container is still there after generation 2 deployed")
	}
	c, ok := h.eng.Get(docker.ContainerName(docker.PanelServiceID, 2, 0))
	if !ok || !c.Running {
		t.Fatal("generation 2 is not running")
	}
	wantBind := filepath.Join(h.layout.Root(), "panel") + ":" + brand.DataDir + "/panel"
	if !slices.Contains(c.Spec.Binds, wantBind) {
		t.Fatalf("binds = %v, want %s", c.Spec.Binds, wantBind)
	}
	if len(c.Spec.Publish) != 1 || c.Spec.Publish[0] != (docker.PortPublish{HostPort: 3100, ContainerPort: 3000}) {
		t.Fatalf("publish = %v", c.Spec.Publish)
	}
	if c.Spec.User != docker.PanelUser || c.Spec.Labels[docker.LabelUser] != docker.PanelUser {
		t.Fatalf("generation 2 runs as %q (label %q), want the panel user %s", c.Spec.User, c.Spec.Labels[docker.LabelUser], docker.PanelUser)
	}
}

// addInstallerPanel adds a running container like the one cli.panelRunArgs
// starts: reserved ids, generation 1, protected, the panel user, no spec
// hash, and Docker publishing the given ports.
func addInstallerPanel(h *harness, publish ...docker.PortPublish) string {
	labels := docker.InstanceLabels{ServiceID: docker.PanelServiceID, ProjectID: docker.PanelProjectID, Kind: "app", Generation: 1, Protected: true, User: docker.PanelUser}.Map()
	return h.eng.AddContainer(docker.ContainerSpec{Name: docker.ContainerName(docker.PanelServiceID, 1, 0), Image: "seylo:1", User: docker.PanelUser, Labels: labels, Publish: publish}, true)
}

// closedPanelSpec is panelSpec with its port published on 127.0.0.1 only.
func closedPanelSpec(gen uint64, image string) *agentv1.ServiceSpec {
	s := panelSpec(gen, image)
	s.Ports[0].Public.BindAddress = "127.0.0.1"
	return s
}

var loopback = netip.MustParseAddr("127.0.0.1")

// The installer's container is adopted only while Docker publishes what
// the spec asks for. One whose bindings differ (open while the panel wants
// it on 127.0.0.1, another host port) is rolled at the same generation, so
// the port is never left open while the panel counts it as closed.
func TestInstallerPanelWithOtherBindingsIsRolled(t *testing.T) {
	for name, tc := range map[string]struct {
		spec *agentv1.ServiceSpec
		want docker.PortPublish
	}{
		"closed":         {closedPanelSpec(1, "seylo:1"), docker.PortPublish{HostIP: loopback, HostPort: 3100, ContainerPort: 3000}},
		"other hostPort": {func() *agentv1.ServiceSpec { s := panelSpec(1, "seylo:1"); s.Ports[0].Public.HostPort = 3200; return s }(), docker.PortPublish{HostPort: 3200, ContainerPort: 3000}},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			installer := addInstallerPanel(h, docker.PortPublish{HostPort: 3100, ContainerPort: 3000})
			h.apply(1, tc.spec)
			h.deployResult(docker.PanelServiceID, 1)
			h.waitFor("the installer's container gone", func() bool { _, ok := h.eng.Get(installer); return !ok })
			c, ok := h.eng.Get(docker.ContainerName(docker.PanelServiceID, 1, 0))
			if !ok || !c.Running || c.ID == installer {
				t.Fatalf("no new generation 1 container running: %+v", c)
			}
			if !slices.Equal(c.Spec.Publish, []docker.PortPublish{tc.want}) {
				t.Fatalf("publish = %v, want %v", c.Spec.Publish, tc.want)
			}
			// Settled: the new container carries a spec hash, so no second roll.
			id := c.ID
			h.apply(2, tc.spec)
			if c, ok := h.eng.Get(docker.ContainerName(docker.PanelServiceID, 1, 0)); !ok || c.ID != id {
				t.Fatalf("the panel rolled again: %v", h.names(docker.PanelServiceID))
			}
		})
	}
}

// A change of bind_address rolls the panel (RECREATE), at the same
// generation and on a bump, and the new container's Docker bindings follow
// it: 127.0.0.1 only, then every address again.
func TestPanelBindAddressChangeRolls(t *testing.T) {
	h := newHarness(t)
	h.apply(1, panelSpec(1, "seylo:1"))
	h.deployResult(docker.PanelServiceID, 1)
	open, _ := h.eng.Get(docker.ContainerName(docker.PanelServiceID, 1, 0))
	if !slices.Equal(open.Spec.Publish, []docker.PortPublish{{HostPort: 3100, ContainerPort: 3000}}) {
		t.Fatalf("open publish = %v", open.Spec.Publish)
	}

	// Same generation, port closed to the server itself.
	h.apply(2, closedPanelSpec(1, "seylo:1"))
	h.waitFor("the closed panel at generation 1", func() bool {
		c, ok := h.eng.Get(docker.ContainerName(docker.PanelServiceID, 1, 0))
		return ok && c.Running && c.ID != open.ID && slices.Equal(c.Spec.Publish, []docker.PortPublish{{HostIP: loopback, HostPort: 3100, ContainerPort: 3000}})
	})
	h.waitFor("the open container gone", func() bool { _, ok := h.eng.Get(open.ID); return !ok })
	if got := h.names(docker.PanelServiceID); len(got) != 1 {
		t.Fatalf("panel containers = %v", got)
	}

	// A new generation opens it again.
	h.apply(3, panelSpec(2, "seylo:1"))
	h.deployResult(docker.PanelServiceID, 2)
	c, ok := h.eng.Get(docker.ContainerName(docker.PanelServiceID, 2, 0))
	if !ok || !c.Running || !slices.Equal(c.Spec.Publish, []docker.PortPublish{{HostPort: 3100, ContainerPort: 3000}}) {
		t.Fatalf("generation 2 = %+v", c.Spec.Publish)
	}
	if got := h.names(docker.PanelServiceID); len(got) != 1 {
		t.Fatalf("panel containers = %v", got)
	}
}

// A closed panel that never turns healthy is rolled back: the open
// container runs again, so a failed close leaves IP access open.
func TestFailedCloseKeepsThePanelOpen(t *testing.T) {
	h := newHarness(t)
	h.apply(1, panelSpec(1, "seylo:1"))
	h.deployResult(docker.PanelServiceID, 1)
	open, _ := h.eng.Get(docker.ContainerName(docker.PanelServiceID, 1, 0))
	h.prober.setBad(docker.ContainerName(docker.PanelServiceID, 2, 0), true)
	closed := closedPanelSpec(2, "seylo:1")
	closed.Deploy.HealthTimeout = durationpb.New(200 * time.Millisecond)
	h.apply(2, closed)
	if p := h.deployResult(docker.PanelServiceID, 2); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED {
		t.Fatalf("closing deploy = %v, want failed", p)
	}
	h.waitFor("the open panel running again", func() bool { c, ok := h.eng.Get(open.ID); return ok && c.Running })
	for _, c := range h.eng.Containers() {
		if c.Spec.Labels[docker.LabelService] == docker.PanelServiceID && c.ID != open.ID {
			t.Fatalf("the failed closed container is left: %+v", c.Spec)
		}
	}
}

// A panel container from before the panel user (no seylo.user label: it
// runs as the image's uid 1000) is replaced once at the same generation by
// one that runs as the panel user, with the folder closed to everyone else.
func TestLegacyPanelMovesToThePanelUser(t *testing.T) {
	for name, labels := range map[string]docker.InstanceLabels{
		// Started by an older installer, never updated.
		"installer": {ServiceID: docker.PanelServiceID, ProjectID: docker.PanelProjectID, Kind: "app", Generation: 1, Protected: true},
		// Swapped in by an older agent's update: it carries a spec hash.
		"older agent": {ServiceID: docker.PanelServiceID, ProjectID: docker.PanelProjectID, Kind: "app", Generation: 1, Protected: true,
			SpecHash: SpecHash(panelSpec(1, "seylo:1"))},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			dir := filepath.Join(h.layout.Root(), "panel")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "master.key"), []byte("key\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			legacy := h.eng.AddContainer(docker.ContainerSpec{Name: docker.ContainerName(docker.PanelServiceID, 1, 0), Image: "seylo:1", User: "1000:1000", Labels: labels.Map()}, true)

			h.apply(1, panelSpec(1, "seylo:1"))
			h.waitFor("the panel running as the panel user", func() bool {
				for _, c := range h.eng.Containers() {
					if c.Running && c.Spec.User == docker.PanelUser && c.Spec.Labels[docker.LabelUser] == docker.PanelUser &&
						c.Spec.Name == docker.ContainerName(docker.PanelServiceID, 1, 0) {
						return true
					}
				}
				return false
			})
			h.waitFor("the old container gone", func() bool { _, ok := h.eng.Get(legacy); return !ok })
			for path, want := range map[string]os.FileMode{dir: 0o700, filepath.Join(dir, "master.key"): 0o600} {
				if info, err := os.Stat(path); err != nil || info.Mode().Perm() != want {
					t.Errorf("%s is %v (%v), want %v", path, info.Mode().Perm(), err, want)
				}
			}
			// Settled: no second roll.
			before := len(h.eng.Containers())
			h.apply(2, panelSpec(1, "seylo:1"))
			if got := h.names(docker.PanelServiceID); len(got) != 1 || before != 1 {
				t.Fatalf("panel containers after a second pass = %v", got)
			}
		})
	}
}

// An account that has the panel's uid (made after the install, or there
// before an upgrade from uid 1000) can read master.key once the folder is
// the panel user's: starting a panel container says so in the agent's log
// and the panel's own log. The installer only checks new installs.
func TestPanelIDHolderIsReported(t *testing.T) {
	warned := func(h *harness) bool {
		for _, line := range h.logs.text(docker.PanelServiceID) {
			if strings.Contains(line, "has id 61000, the panel's user") {
				return true
			}
		}
		return false
	}

	free := newHarness(t)
	free.apply(1, panelSpec(1, "seylo:1"))
	free.deployResult(docker.PanelServiceID, 1)
	if warned(free) {
		t.Fatalf("a free panel id was reported: %v", free.logs.text(docker.PanelServiceID))
	}

	h := newHarness(t)
	if err := os.WriteFile(filepath.Join(h.etc, "passwd"), []byte("root:x:0:0::/root:/bin/bash\nops:x:61000:61000::/home/ops:/bin/bash\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.apply(1, panelSpec(1, "seylo:1"))
	h.deployResult(docker.PanelServiceID, 1)
	if !warned(h) {
		t.Fatalf("panel log = %v, want the account with the panel's id named", h.logs.text(docker.PanelServiceID))
	}
	found := false
	for _, line := range h.logs.text(docker.PanelServiceID) {
		found = found || strings.Contains(line, "the user ops on this server has id 61000") && strings.Contains(line, filepath.Join(h.layout.Root(), "panel"))
	}
	if !found {
		t.Fatalf("panel log = %v, want the account and the folder named", h.logs.text(docker.PanelServiceID))
	}
}

// When the panel cannot start as the panel user, the old container comes
// back as it was (set aside under another name, not removed).
func TestLegacyPanelComesBackWhenTheMoveFails(t *testing.T) {
	h := newHarness(t)
	name := docker.ContainerName(docker.PanelServiceID, 1, 0)
	labels := docker.InstanceLabels{ServiceID: docker.PanelServiceID, ProjectID: docker.PanelProjectID, Kind: "app", Generation: 1, Protected: true}.Map()
	legacy := h.eng.AddContainer(docker.ContainerSpec{Name: name, Image: "seylo:1", User: "1000:1000", Labels: labels}, true)
	// Only the container under the canonical name fails its health check;
	// the old one is renamed aside first.
	h.prober.setBad(name, true)
	spec := panelSpec(1, "seylo:1")
	spec.Deploy.HealthTimeout = durationpb.New(200 * time.Millisecond)
	h.apply(1, spec)
	h.waitFor("the old panel running again", func() bool {
		c, ok := h.eng.Get(legacy)
		return ok && c.Running && c.Spec.Name == name+"-prev"
	})
	for _, c := range h.eng.Containers() {
		if c.ID != legacy && c.Spec.Labels[docker.LabelService] == docker.PanelServiceID {
			t.Fatalf("the failed panel container is left: %+v", c.Spec)
		}
	}
}

func TestOnlyThePanelGetsBindAndPublish(t *testing.T) {
	h := newHarness(t)
	s := appSpec("svc", 1, "app:v1")
	s.Protected = true
	s.Ports[0].Public = &agentv1.PublicPort{HostPort: 8080, Mode: agentv1.PublicPortMode_PUBLIC_PORT_MODE_FORWARD}
	h.apply(1, s)
	h.deployResult("svc", 1)
	c, _ := h.eng.Get(docker.ContainerName("svc", 1, 0))
	if len(c.Spec.Publish) != 0 {
		t.Fatalf("a protected non-panel service was published by Docker: %v", c.Spec.Publish)
	}
	for _, b := range c.Spec.Binds {
		if strings.HasSuffix(b, brand.DataDir+"/panel") {
			t.Fatalf("a non-panel service got the panel folder: %v", c.Spec.Binds)
		}
	}
}

func TestUnprotectedInstanceWithoutHashIsRolled(t *testing.T) {
	h := newHarness(t)
	labels := docker.InstanceLabels{ServiceID: "svc", ProjectID: "p1", Kind: "app", Generation: 1}.Map()
	old := h.eng.AddContainer(docker.ContainerSpec{Name: docker.ContainerName("svc", 1, 0), Image: "app:v1", Labels: labels}, true)
	h.apply(1, appSpec("svc", 1, "app:v1"))
	h.deployResult("svc", 1)
	if _, ok := h.eng.Get(old); ok {
		t.Fatal("an unprotected container without a spec hash was adopted")
	}
}
