package proxy

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/seylo-dev/app/go/internal/docker"
)

// The LB entry point keeps the forwarded headers the node a visitor came
// in through set, and does not append that node: in the agent's own
// Traefik and in the LB-only one next to the Wings fork alike. web and
// websecure keep Traefik's default, which drops what a visitor sends.
func TestArgsLBEntryPointKeepsTheVisitor(t *testing.T) {
	want := []string{
		"--entrypoints." + EntryPointLB + ".forwardedHeaders.insecure=true",
		"--entrypoints." + EntryPointLB + ".forwardedHeaders.notAppendXForwardedFor=true",
	}
	for _, c := range []TraefikConfig{
		{LBPort: DefaultLBPort},
		{LBPort: DefaultLBPort, LBOnly: true},
	} {
		args := c.Args()
		for _, w := range want {
			if !slices.Contains(args, w) {
				t.Errorf("LBOnly=%v: %q missing from %v", c.LBOnly, w, args)
			}
		}
		for _, a := range args {
			if strings.Contains(a, "forwardedHeaders") && !strings.HasPrefix(a, "--entrypoints."+EntryPointLB+".") {
				t.Errorf("LBOnly=%v: %q trusts forwarded headers outside the LB entry point", c.LBOnly, a)
			}
		}
	}
	for _, a := range (TraefikConfig{}).Args() {
		if strings.Contains(a, "forwardedHeaders") || strings.Contains(a, EntryPointLB) {
			t.Errorf("no LB entry point, yet %q", a)
		}
	}
}

// ipv6Docker is a proxy.Docker that can make IPv6 networks, recording
// what was asked of it.
type ipv6Docker struct {
	calls []string
	// lifecycle is the container's: pull, remove, create, start.
	lifecycle []string
	created   *ContainerSpec
	running   bool
	networks  []string // Traefik's networks
	failNet   error
}

func (f *ipv6Docker) InspectContainer(_ context.Context, name string) (ContainerInfo, error) {
	if f.created == nil {
		return ContainerInfo{}, ErrContainerNotFound
	}
	return ContainerInfo{ID: "t", Running: f.running, Labels: f.created.Labels, IPs: map[string]string{"edge": "172.30.0.2"}, Networks: slices.Clone(f.networks),
		Image: f.created.Image, Cmd: f.created.Cmd}, nil
}
func (f *ipv6Docker) CreateContainer(_ context.Context, spec ContainerSpec) (string, error) {
	f.lifecycle = append(f.lifecycle, "create")
	f.created, f.networks, f.running = &spec, []string{spec.Network}, false
	return "t", nil
}
func (f *ipv6Docker) StartContainer(context.Context, string) error {
	f.lifecycle = append(f.lifecycle, "start")
	f.running = true
	return nil
}
func (f *ipv6Docker) RemoveContainer(context.Context, string) error {
	f.lifecycle = append(f.lifecycle, "remove")
	f.created = nil
	return nil
}
func (f *ipv6Docker) EnsureImage(_ context.Context, ref string) error {
	f.lifecycle = append(f.lifecycle, "pull "+ref)
	return nil
}
func (f *ipv6Docker) EnsureNetwork(context.Context, string, map[string]string) (NetworkInfo, error) {
	return NetworkInfo{Gateway: "172.30.0.1"}, nil
}
func (f *ipv6Docker) ConnectNetwork(_ context.Context, network, container string) error {
	f.calls = append(f.calls, "connect "+network+" "+container)
	f.networks = append(f.networks, network)
	return nil
}
func (f *ipv6Docker) ContainerEvents(context.Context, string) (<-chan string, <-chan error) {
	return nil, nil
}
func (f *ipv6Docker) EnsureIPv6Network(_ context.Context, name string, labels map[string]string) error {
	f.calls = append(f.calls, "ipv6 network "+name+" role="+labels[docker.LabelRole])
	return f.failNet
}

// noIPv6Docker cannot make IPv6 networks.
type noIPv6Docker struct{ Docker }

// A Traefik of another image or other arguments is replaced only once
// the new image is there: the old one serves while it downloads.
func TestEnsurePullsBeforeRemoving(t *testing.T) {
	old := TraefikConfig{Name: "tr", Image: "traefik:old", Network: "edge", DynamicDir: t.TempDir(), DataDir: t.TempDir()}
	d := &ipv6Docker{}
	if _, err := (&Traefik{Docker: d, Config: old}).Ensure(context.Background()); err != nil {
		t.Fatal(err)
	}
	d.created.Labels[docker.LabelManaged] = "true"
	d.lifecycle = nil
	next := old
	next.Image = "traefik:new"
	st, err := (&Traefik{Docker: d, Config: next}).Ensure(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"pull traefik:new", "remove", "pull traefik:new", "create", "start"}; !slices.Equal(d.lifecycle, want) || st.Recreated != "image changed" {
		t.Fatalf("%v (%q), want %v", d.lifecycle, st.Recreated, want)
	}
}

// Ensure puts Traefik on the IPv6 network once (made when missing), says
// why when it cannot, and leaves it alone without one configured.
func TestEnsureJoinsTheIPv6Network(t *testing.T) {
	cfg := TraefikConfig{Name: "tr", Network: "edge", DynamicDir: t.TempDir(), DataDir: t.TempDir(), IPv6Network: "edge6"}
	d := &ipv6Docker{}
	st, err := (&Traefik{Docker: d, Config: cfg}).Ensure(context.Background())
	if err != nil || st.IPv6Problem != "" {
		t.Fatalf("%v %q", err, st.IPv6Problem)
	}
	if want := []string{"ipv6 network edge6 role=edge", "connect edge6 tr"}; !slices.Equal(d.calls, want) {
		t.Fatalf("calls %v, want %v", d.calls, want)
	}
	// Already on it: nothing more.
	if _, err := (&Traefik{Docker: d, Config: cfg}).Ensure(context.Background()); err != nil || len(d.calls) != 2 {
		t.Fatalf("second Ensure: %v %v", err, d.calls)
	}

	// The network cannot be made: Traefik runs, the reason is reported.
	d = &ipv6Docker{failNet: errors.New("old Docker")}
	st, err = (&Traefik{Docker: d, Config: cfg}).Ensure(context.Background())
	if err != nil || st.IPv6Problem != "old Docker" || slices.Contains(d.calls, "connect edge6 tr") {
		t.Fatalf("%v %q %v", err, st.IPv6Problem, d.calls)
	}
	st, err = (&Traefik{Docker: noIPv6Docker{&ipv6Docker{}}, Config: cfg}).Ensure(context.Background())
	if err != nil || st.IPv6Problem == "" {
		t.Fatalf("a Docker without IPv6 networks: %v %q", err, st.IPv6Problem)
	}

	// Not configured: no IPv6 network.
	cfg.IPv6Network = ""
	d = &ipv6Docker{}
	if st, err := (&Traefik{Docker: d, Config: cfg}).Ensure(context.Background()); err != nil || st.IPv6Problem != "" || len(d.calls) != 0 {
		t.Fatalf("%v %q %v", err, st.IPv6Problem, d.calls)
	}
}

func TestRecreateReasonNamesWhatChanged(t *testing.T) {
	base := TraefikConfig{Name: "seylo-traefik", Image: "traefik:v1", Network: "edge", DynamicDir: "/d", DataDir: "/a", HTTPPort: 80, HTTPSPort: 443}
	running := func(c TraefikConfig) ContainerInfo {
		spec := c.Spec()
		return ContainerInfo{Image: spec.Image, Cmd: spec.Cmd}
	}
	withEmail := base
	withEmail.AcmeEmail = "owner@example.com"
	otherEmail := base
	otherEmail.AcmeEmail = "new-owner@example.com"
	newImage := withEmail
	newImage.Image = "traefik:v2"
	otherPort := withEmail
	otherPort.HTTPPort = 8080

	cases := []struct {
		name     string
		existing ContainerInfo
		next     TraefikConfig
		want     string
	}{
		{"owner created", running(base), withEmail, "ACME contact email changed"},
		{"owner's email changed", running(withEmail), otherEmail, "ACME contact email changed"},
		{"agent update with a new image", running(withEmail), newImage, "image changed"},
		{"both", running(base), newImage, "image changed, ACME contact email changed"},
		{"something else", running(withEmail), otherPort, "configuration changed"},
		{"Docker did not say", ContainerInfo{}, withEmail, "configuration changed"},
	}
	for _, c := range cases {
		if got := recreateReason(c.existing, c.next.Spec()); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}
