// The agent's own Traefik container. Adapted from the Wings fork's
// proxy/proxy.go (MIT, see the notice in dynamic.go).

package proxy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/docker"
)

// TraefikImage is the pinned Traefik release (the same as the Wings fork's).
const TraefikImage = "traefik:v3.7.15"

// LetsEncryptStaging is the staging directory, for the staging switch.
const LetsEncryptStaging = "https://acme-staging-v02.api.letsencrypt.org/directory"

// Paths inside the Traefik container.
const (
	containerDynamicDir = "/etc/traefik/dynamic"
	containerDataDir    = "/data"
	containerCAFile     = "/etc/traefik/acme-ca.pem"
)

// specLabel holds the hash of everything the container was made from; a
// change recreates it.
const specLabel = docker.LabelPrefix + "traefik.spec"

// TraefikConfig is the agent's own Traefik.
type TraefikConfig struct {
	// Name of the container, docker.TraefikContainer in production.
	Name string
	// Image, TraefikImage by default.
	Image string
	// Network is the edge network Traefik shares with routed containers.
	Network string
	// DynamicDir and DataDir are host folders: route files, and acme.json.
	DynamicDir string
	DataDir    string
	// Host ports for web (80), websecure (443) and the LB entry point
	// (5757). LBPort 0 leaves the LB entry point out.
	HTTPPort, HTTPSPort, LBPort uint16
	// AcmeEmail is the Let's Encrypt account contact.
	AcmeEmail string
	// AcmeCAServer overrides the ACME directory (LetsEncryptStaging, or a
	// test CA). Empty is Let's Encrypt production.
	AcmeCAServer string
	// CgroupParent, docker.CgroupParent in production.
	CgroupParent string
	// ExtraLabels are added to the container (tests use them to clean up).
	ExtraLabels map[string]string
	// Env for the container, for example LEGO_CA_CERTIFICATES to trust a
	// test CA.
	Env []string
	// CACertFile is a host PEM file of extra ACME directory roots (a test
	// CA): mounted read-only and handed to lego as LEGO_CA_CERTIFICATES.
	CACertFile string
	// CAServerName (with CACertFile) is the name lego verifies the ACME
	// directory's certificate against (LEGO_CA_SERVER_NAME).
	CAServerName string
	// LBOnly makes the LB Traefik used next to the Wings fork: only the LB
	// entry point (LBPort), no web/websecure, no ACME. The fork's Traefik
	// serves everything else.
	LBOnly bool
	// IPv6Network is an IPv6-only network Traefik joins next to Network
	// (IPv4 only), so Docker forwards visitors over IPv6 to Traefik's own
	// IPv6 address there and Traefik sees their address. Without it
	// Docker's userland proxy takes IPv6 connections to the published
	// ports and every IPv6 visitor arrives from Network's gateway. Empty
	// leaves it out (VisitorIPv6 says when a node gets it).
	IPv6Network string
}

// LBTraefikContainer is the LB-only Traefik next to the Wings fork.
const LBTraefikContainer = docker.TraefikContainer + "-lb"

// Defaults for the production Traefik.
const (
	DefaultLBPort = 5757
)

// AcmeFile is acme.json on the host.
func (c TraefikConfig) AcmeFile() string { return filepath.Join(c.DataDir, "acme.json") }

// Args is Traefik's static configuration: routes only from the files the
// agent writes (watched), entry points web, websecure and the LB entry
// point, one ACME resolver with the HTTP challenge on web. No API, no
// dashboard, no Docker provider.
func (c TraefikConfig) Args() []string {
	if c.LBOnly {
		args := []string{
			"--providers.file.directory=" + containerDynamicDir,
			"--providers.file.watch=true",
			"--providers.providersThrottleDuration=500ms",
			"--entrypoints." + EntryPointLB + ".address=:" + fmt.Sprint(DefaultLBPort),
			"--entrypoints." + EntryPointLB + ".http.tls=true",
			"--global.checknewversion=false",
			"--global.sendanonymoususage=false",
			"--log.level=INFO",
		}
		return append(args, lbEntryPointArgs()...)
	}
	args := []string{
		"--providers.file.directory=" + containerDynamicDir,
		"--providers.file.watch=true",
		"--providers.providersThrottleDuration=500ms",
		"--entrypoints." + EntryPointWeb + ".address=:80",
		"--entrypoints." + EntryPointSecure + ".address=:443",
		"--certificatesresolvers." + CertResolver + ".acme.storage=" + containerDataDir + "/acme.json",
		"--certificatesresolvers." + CertResolver + ".acme.httpchallenge=true",
		"--certificatesresolvers." + CertResolver + ".acme.httpchallenge.entrypoint=" + EntryPointWeb,
		"--global.checknewversion=false",
		"--global.sendanonymoususage=false",
		"--log.level=INFO",
	}
	if c.LBPort != 0 {
		args = append(args,
			"--entrypoints."+EntryPointLB+".address=:"+fmt.Sprint(DefaultLBPort),
			"--entrypoints."+EntryPointLB+".http.tls=true",
		)
		args = append(args, lbEntryPointArgs()...)
	}
	if c.AcmeEmail != "" {
		args = append(args, "--certificatesresolvers."+CertResolver+".acme.email="+c.AcmeEmail)
	}
	if c.AcmeCAServer != "" {
		args = append(args, "--certificatesresolvers."+CertResolver+".acme.caserver="+c.AcmeCAServer)
	}
	return args
}

// lbEntryPointArgs are the LB entry point's own settings, the same in the
// LB-only Traefik. Only other nodes reach its routers (a client
// certificate the panel issued to a current node, lbtls.go; without one
// no router matches), and the node a visitor came in through already set
// X-Forwarded-For, X-Real-Ip and X-Forwarded-Proto from what it saw (it
// drops what the visitor sent). So the headers are kept as they come
// (insecure: the peers' addresses are not known up front), and the
// forwarding node's address is not appended: the app sees the visitor as
// the last X-Forwarded-For hop and the scheme the visitor used, not the
// LB entry point's https.
func lbEntryPointArgs() []string {
	return []string{
		"--entrypoints." + EntryPointLB + ".forwardedHeaders.insecure=true",
		"--entrypoints." + EntryPointLB + ".forwardedHeaders.notAppendXForwardedFor=true",
	}
}

// Spec is the container the config asks for. Pure, for tests.
func (c TraefikConfig) Spec() ContainerSpec {
	image := c.Image
	if image == "" {
		image = TraefikImage
	}
	ports := []PortBinding{{ContainerPort: 80, HostPort: c.HTTPPort}, {ContainerPort: 443, HostPort: c.HTTPSPort}}
	if c.LBOnly {
		ports = nil
	}
	if c.LBPort != 0 {
		ports = append(ports, PortBinding{ContainerPort: DefaultLBPort, HostPort: c.LBPort})
	}
	labels := map[string]string{
		docker.LabelManaged:       "true",
		docker.LabelRole:          "traefik",
		docker.LabelTraefikEnable: "false",
	}
	for k, v := range c.ExtraLabels {
		labels[k] = v
	}
	env := c.Env
	mounts := []BindMount{
		{Source: c.DynamicDir, Target: containerDynamicDir, ReadOnly: true},
		{Source: c.DataDir, Target: containerDataDir},
	}
	if c.CACertFile != "" && !c.LBOnly {
		env = append(append([]string(nil), env...), "LEGO_CA_CERTIFICATES="+containerCAFile)
		if c.CAServerName != "" {
			env = append(env, "LEGO_CA_SERVER_NAME="+c.CAServerName)
		}
		mounts = append(mounts, BindMount{Source: c.CACertFile, Target: containerCAFile, ReadOnly: true})
	}
	spec := ContainerSpec{
		Name:                 c.Name,
		Image:                image,
		Cmd:                  c.Args(),
		Env:                  env,
		Labels:               labels,
		Network:              c.Network,
		Ports:                ports,
		Mounts:               mounts,
		CgroupParent:         c.CgroupParent,
		RestartUnlessStopped: true,
	}
	sum := sha256.New()
	_ = json.NewEncoder(sum).Encode(spec)
	spec.Labels[specLabel] = hex.EncodeToString(sum.Sum(nil))[:16]
	return spec
}

// Traefik keeps the agent's own Traefik container matching its config.
type Traefik struct {
	Docker Docker
	Config TraefikConfig
}

// TraefikState is what Ensure found or made.
type TraefikState struct {
	ContainerID string
	// IP of Traefik on the edge network and the network's gateway (the
	// host's address there, where the edge listener binds).
	IP      string
	Gateway string
	// Recreated says why Ensure replaced a container that no longer
	// matched the config, for example "ACME contact email changed". Empty
	// when it kept the container or created a missing one.
	Recreated string
	// IPv6Problem says why Traefik is not on IPv6Network (visitors over
	// IPv6 still arrive from the edge gateway). Not an error: IPv4 and
	// routing work without it.
	IPv6Problem string
}

// Ensure creates the edge network and the Traefik container when missing,
// recreates it when its config changed and starts it when stopped.
func (t *Traefik) Ensure(ctx context.Context) (TraefikState, error) {
	c := t.Config
	netInfo, err := t.Docker.EnsureNetwork(ctx, c.Network, map[string]string{docker.LabelManaged: "true", docker.LabelRole: "edge"})
	if err != nil {
		return TraefikState{}, err
	}
	for _, dir := range []string{c.DynamicDir, c.DataDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return TraefikState{}, fmt.Errorf("creating %s: %w", dir, err)
		}
	}
	spec := c.Spec()
	existing, err := t.Docker.InspectContainer(ctx, c.Name)
	found := err == nil
	if err != nil && !errors.Is(err, ErrContainerNotFound) {
		return TraefikState{}, err
	}
	recreated := ""
	if found && existing.Labels[specLabel] != spec.Labels[specLabel] {
		if existing.Labels[docker.LabelManaged] != "true" {
			return TraefikState{}, fmt.Errorf("a container named %s exists and is not managed by %s", c.Name, brand.DisplayName)
		}
		// A new image is pulled while the old Traefik still serves: the
		// sites are down only from the removal to the new one's start
		// (about half a second in the test VM).
		if err := t.Docker.EnsureImage(ctx, spec.Image); err != nil {
			return TraefikState{}, err
		}
		if err := t.Docker.RemoveContainer(ctx, existing.ID); err != nil {
			return TraefikState{}, err
		}
		found = false
		recreated = recreateReason(existing, spec)
	}
	if !found {
		if err := t.Docker.EnsureImage(ctx, spec.Image); err != nil {
			return TraefikState{}, err
		}
		id, err := t.Docker.CreateContainer(ctx, spec)
		if err != nil {
			return TraefikState{}, err
		}
		existing = ContainerInfo{ID: id}
	}
	if !existing.Running {
		if err := t.Docker.StartContainer(ctx, existing.ID); err != nil {
			return TraefikState{}, err
		}
	}
	info, err := t.Docker.InspectContainer(ctx, c.Name)
	if err != nil {
		return TraefikState{}, err
	}
	return TraefikState{ContainerID: info.ID, IP: info.IPs[c.Network], Gateway: netInfo.Gateway, Recreated: recreated,
		IPv6Problem: t.joinIPv6(ctx, info)}, nil
}

// DualStackDocker is implemented by a Docker that can make the network
// for visitors over IPv6 (MobyDocker).
type DualStackDocker interface {
	// EnsureIPv6Network creates an IPv6-only bridge network when missing.
	EnsureIPv6Network(ctx context.Context, name string, labels map[string]string) error
}

// joinIPv6 connects the running Traefik to IPv6Network (made when
// missing) and returns why it could not, "" when it is on it. After the
// start, not before: a network Docker cannot find at start would keep the
// container from starting, and Docker moves the IPv6 port mappings to the
// new network at once. IPv4 stays on Network: IPv6Network has no IPv4.
func (t *Traefik) joinIPv6(ctx context.Context, info ContainerInfo) string {
	c := t.Config
	if c.IPv6Network == "" || slices.Contains(info.Networks, c.IPv6Network) {
		return ""
	}
	dual, ok := t.Docker.(DualStackDocker)
	if !ok {
		return "this Docker client cannot create IPv6 networks"
	}
	if err := dual.EnsureIPv6Network(ctx, c.IPv6Network, map[string]string{docker.LabelManaged: "true", docker.LabelRole: "edge"}); err != nil {
		return err.Error()
	}
	if err := t.Docker.ConnectNetwork(ctx, c.IPv6Network, c.Name); err != nil {
		return err.Error()
	}
	return ""
}

// recreateReason says what differs between a container and the spec that
// replaces it: the image, the ACME contact email, or else the
// configuration in general (ports, mounts, other flags, the CA file).
func recreateReason(existing ContainerInfo, spec ContainerSpec) string {
	var changed []string
	if existing.Image != "" && existing.Image != spec.Image {
		changed = append(changed, "image changed")
	}
	if existing.Cmd != nil && acmeEmailArg(existing.Cmd) != acmeEmailArg(spec.Cmd) {
		changed = append(changed, "ACME contact email changed")
	}
	if len(changed) == 0 {
		return "configuration changed"
	}
	return strings.Join(changed, ", ")
}

// acmeEmailArg is the ACME contact email in Traefik's arguments, "" when
// there is none.
func acmeEmailArg(args []string) string {
	prefix := "--certificatesresolvers." + CertResolver + ".acme.email="
	for _, arg := range args {
		if email, ok := strings.CutPrefix(arg, prefix); ok {
			return email
		}
	}
	return ""
}
