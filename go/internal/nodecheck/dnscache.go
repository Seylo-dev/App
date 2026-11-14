package nodecheck

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/netip"
	"slices"
	"strings"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dnscache"
	"github.com/seylo-dev/app/go/internal/docker"
)

// The DNS cache check (docker.dnscache, since 0.2.17): with the node's DNS
// cache on (NodeSettings.dns_cache), containers reach it and it answers.
// The agent's dnscache.Manager runs the test (Env.DNSCache): from the host
// it resolves the panel's host through the cache's own address (the
// listener and the upstreams work), and from inside throwaway containers
// (ProbeDNSCache: an image already on the node, never pulled) busybox
// nslookup asks the cache for a name it answers itself, once on Docker's
// default bridge and once on a project network, which proves no firewall
// drops containers' DNS to the cache. The same test is the gate: new
// containers get the cache only after it passed.
//
// This file is the check's own part; the Container DNS check
// (dockerdns.go) treats the cache's address like any other server.

const dnsCacheTitle = "DNS cache"

// dnsCacheEffect is what the cache does and does not do, for details.
const dnsCacheEffect = "it cuts repeated lookups of the same names; it is no hard limit on DNS traffic"

// dnsCache is the docker.dnscache check.
func (e *Env) dnsCache(ctx context.Context) *agentv1.NodeCheckResult {
	if e.DNSCache == nil {
		return skipped("only the agent checks the DNS cache")
	}
	return judgeDNSCache(e.DNSCache(ctx))
}

// judgeDNSCache turns the cache's test into the check's result.
func judgeDNSCache(r *dnscache.Report) *agentv1.NodeCheckResult {
	if r == nil {
		return skipped("the DNS cache is off on this node")
	}
	addr := r.Address.String()
	users := usersText(r.Users)
	if !r.Enabled {
		// Turned off, still draining: it keeps answering the containers
		// created with it until they are redeployed.
		if r.Passed() || r.Problem() == "" {
			return pass("the DNS cache is off; %s still %s it at %s until %s redeployed", users, plural(r.Users, "uses", "use"), addr, plural(r.Users, "it is", "they are"))
		}
		return fail(fmt.Sprintf("the DNS cache is off, but %s still %s it at %s and it does not answer them: %s; each of their lookups can wait about 4 seconds before Docker tries the next server",
			users, plural(r.Users, "uses", "use"), addr, r.Problem()), strings.TrimSpace(r.FixHint()+" Or redeploy those services, which gives them Docker's own servers again."))
	}
	if r.Blocked != "" {
		return fail("the DNS cache cannot run on this node: "+r.Blocked+"; new containers keep Docker's own DNS servers", r.FixHint())
	}
	if r.HostErr != "" {
		detail := fmt.Sprintf("the DNS cache at %s gets no answer from its upstream servers (%s): %s; new containers keep Docker's own DNS servers until it does",
			addr, strings.Join(r.Upstreams, ", "), r.HostErr)
		return fail(detail+usingNote(r), r.FixHint())
	}
	if len(r.Runs) == 0 {
		return warn(fmt.Sprintf("the DNS cache at %s answers on the host, but no test container could run (%s), so whether containers reach it is not known; new containers keep Docker's own DNS servers until it is",
			addr, r.Skipped), r.FixHint())
	}
	var nets []string
	for i, run := range r.Runs {
		if !r.RunPassed(i) {
			return fail(fmt.Sprintf("a test container on %s gets no answer from the DNS cache at %s%s; new containers keep Docker's own DNS servers until it does",
				run.Network, addr, runText(run))+usingNote(r), r.FixHint())
		}
		nets = append(nets, run.Network)
	}
	return pass("containers on %s reach the DNS cache at %s and it answers %s through %s; %s %s it (%s)",
		strings.Join(nets, " and "), addr, r.HostName, strings.Join(r.Upstreams, ", "), users, plural(r.Users, "uses", "use"), dnsCacheEffect)
}

func usersText(n int) string {
	switch {
	case n < 0:
		return "containers"
	case n == 1:
		return "1 container"
	}
	return fmt.Sprintf("%d containers", n)
}

// usingNote says what a failure costs the containers that use the cache.
func usingNote(r *dnscache.Report) string {
	if r.Users <= 0 {
		return ""
	}
	return fmt.Sprintf("; %s already %s it, and each of their lookups can wait about 4 seconds before Docker tries the next server",
		usersText(r.Users), plural(r.Users, "uses", "use"))
}

// runText is a failed test container's own words.
func runText(run dnscache.ProbeRun) string {
	if w := run.Why(); w != "" {
		return " (" + w + ")"
	}
	return ""
}

// probeImages lists the images the cache's test can use, in probeRepos
// order: every one has busybox's nslookup.
func probeImages(list string) []string {
	var out []string
	for _, repo := range probeRepos {
		for _, ref := range strings.Fields(list) {
			if pickProbeImage(ref) != "" && probeRepo(ref) == repo && !slices.Contains(out, ref) {
				out = append(out, ref)
				break
			}
		}
	}
	return out
}

// probeRepo is an image reference's repository without docker.io/library.
func probeRepo(ref string) string {
	i := strings.LastIndexByte(ref, ':')
	if i < 0 {
		return ref
	}
	return strings.TrimPrefix(strings.TrimPrefix(ref[:i], "docker.io/"), "library/")
}

// ProbeDNSCache is the DNS cache's test from inside containers
// (dnscache.ProbeFunc): busybox nslookup in a throwaway container from an
// image already on the node, asking addr for probe-<random>.<zone>, once
// on Docker's default bridge and once on a project network when there is
// one (where apps run). The containers carry the Container DNS check's
// label, so a run cut off is removed by the next check.
func ProbeDNSCache(env Env) dnscache.ProbeFunc {
	env.defaults()
	e := &env
	return func(ctx context.Context, addr netip.Addr, zone string) ([]dnscache.ProbeRun, string) {
		ctx, cancel := context.WithTimeout(ctx, 2*probeTimeout)
		defer cancel()
		list, err := e.dockerCLI(ctx, "image", "ls", "--format", "{{.Repository}}:{{.Tag}}")
		if err != nil {
			return nil, "Docker's images could not be listed"
		}
		images := probeImages(list)
		if len(images) == 0 {
			return nil, "no " + strings.Join(probeRepos[:len(probeRepos)-1], ", ") + " or " + probeRepos[len(probeRepos)-1] + " image on this node, and the test pulls none"
		}
		e.removeLeftoverProbes(ctx)
		networks := []string{"bridge"}
		if n := e.projectNetwork(ctx); n != "" {
			networks = append(networks, n)
		}
		var runs []dnscache.ProbeRun
		for _, network := range networks {
			runs = append(runs, e.probeCacheOn(ctx, network, images, addr, zone))
		}
		return runs, ""
	}
}

// projectNetwork is one of our project networks, the first by name; ""
// when there is none.
func (e *Env) projectNetwork(ctx context.Context) string {
	out, err := e.dockerCLI(ctx, "network", "ls", "--filter", "label="+docker.LabelManaged+"=true", "--format", "{{.Name}}")
	if err != nil {
		return ""
	}
	prefix := docker.ProjectNetwork("")
	var names []string
	for _, n := range strings.Fields(out) {
		if strings.HasPrefix(n, prefix) {
			names = append(names, n)
		}
	}
	slices.Sort(names)
	if len(names) == 0 {
		return ""
	}
	return names[0]
}

// probeCacheOn runs one test container on network: the first image whose
// container runs nslookup at all (one without it is skipped).
func (e *Env) probeCacheOn(ctx context.Context, network string, images []string, addr netip.Addr, zone string) dnscache.ProbeRun {
	var b [6]byte
	_, _ = rand.Read(b[:])
	name := "probe-" + hex.EncodeToString(b[:]) + "." + strings.TrimSuffix(zone, ".")
	run := dnscache.ProbeRun{Network: network, Name: name}
	for _, image := range images {
		run.Image = image
		var nb [4]byte
		_, _ = rand.Read(nb[:])
		container := brand.Slug + "-dnscheck-" + hex.EncodeToString(nb[:])
		runCtx, cancel := context.WithTimeout(ctx, probeTimeout)
		out, err := e.dockerCLI(runCtx, "run", "--rm", "--name", container, "--pull", "never", "--network", network,
			"--label", docker.LabelDNSCheck+"=true", "--label", docker.LabelTraefikEnable+"=false",
			"--entrypoint", "nslookup", image, name, addr.String())
		cancel()
		run.Output, run.Err = out, ""
		if err == nil {
			return run
		}
		rmCtx, rmCancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		_, _ = e.dockerCLI(rmCtx, "rm", "-f", container)
		rmCancel()
		run.Err = commandMessage(err)
		if strings.Contains(out, dnscache.ProbeAnswer.String()) {
			// busybox nslookup exits 1 when the AAAA question has no
			// answer; the A answer is what counts.
			run.Err = ""
			return run
		}
		if !strings.Contains(run.Err, "executable file not found") && !strings.Contains(run.Err, "no such file or directory") {
			return run
		}
	}
	return run
}

// DockerDNSSetting is Docker's "dns" setting (dockerd's --dns flags, then
// daemon.json's "dns"), read the way the Container DNS check reads it:
// the entries as written, nil when there is none. The DNS cache forwards
// to these servers and gives them to containers as fallbacks.
func DockerDNSSetting(env Env) func(ctx context.Context) []string {
	env.defaults()
	e := &env
	return func(ctx context.Context) []string {
		return e.daemonDNS(ctx).servers()
	}
}
