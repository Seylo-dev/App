package nodecheck

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// The Container DNS check's lookup: a short-lived test container on our
// edge network (docker.EdgeNetwork, which the agent creates and Traefik
// and every routed app join) resolves a well-known name the way an app's
// container does, through Docker's embedded DNS (127.0.0.11), which
// forwards to the servers of Docker's "dns" setting or the host's.
// Reading resolv.conf says which servers containers get; only a lookup
// says whether those servers answer from this node, and how fast. A node
// whose provider's firewall dropped its DNS to public servers had valid
// servers in every file and no working lookup.
//
// The container runs the image the resolv.conf test container uses (one
// already on the node, never pulled: BuildKit's, Traefik's, alpine or
// busybox, which all have sh and busybox's nslookup; one from before
// busybox 1.29, or built without its full nslookup, takes no options and
// prints its usage: no lookup, not a failed one), with the same
// seylo.dnscheck label (a leftover is removed by a later run), and is gone
// when the lookup is (`docker run --rm`, `docker rm -f` when the run is
// cut off). It only joins the network while it runs: no running container
// is touched. nslookup gives up after lookupWait and the whole run,
// Docker's start and stop of the container included, is bounded by
// lookupTimeout. The time reported is the lookup's own, read from
// /proc/uptime in the container before and after it (10 ms steps).

const (
	// lookupWait is nslookup's own limit (busybox's -timeout, within which
	// it sends the query again): about what apps wait (glibc's default
	// timeout is 5 s).
	lookupWait = 5 * time.Second
	// lookupTimeout bounds the test container's whole run.
	lookupTimeout = 20 * time.Second
	// slowLookup: an answer that took this long is slow. Public resolvers
	// answer in tens of milliseconds; a lost query costs a resend (busybox
	// sends again after half of lookupWait) or a wait for the next server.
	slowLookup = time.Second
)

// lookupScript runs in the test container as `sh -c lookupScript sh
// <name>`: the uptime before and after nslookup, its exit status and the
// container's resolv.conf (where the embedded DNS forwards), on lines that
// start with "@".
var lookupScript = `read a b </proc/uptime; echo "@start $a"; nslookup -type=a -timeout=` +
	strconv.Itoa(int(lookupWait/time.Second)) +
	` "$1" 2>&1; echo "@exit $?"; read a b </proc/uptime; echo "@end $a"; echo "@resolv.conf"; cat /etc/resolv.conf`

// dnsLookup is the test container's lookup, or why there was none.
type dnsLookup struct {
	// Name is the name looked up, Network the network the container ran on.
	Name, Network string
	Image         string
	// Took is the lookup's own time, without Docker's start of the
	// container.
	Took time.Duration
	// Address is the answer's first address, "" when none came.
	Address string
	// Error is what nslookup said when no address came.
	Error string
	// RC is the test container's resolv.conf: Docker's embedded DNS and
	// (Docker 25 and later) the servers it forwards to.
	RC *resolvConf
	// Skipped says why no lookup ran.
	Skipped string
}

// lookupNoImage: no image for a test container, which the resolv.conf
// test container's note already says, so the detail does not repeat it.
const lookupNoImage = "no lookup from a test container either"

// lookupName is the name the test container resolves: the first of the
// DNS check's ResolveNames (github.com by default).
func (e *Env) lookupName() string {
	if len(e.ResolveNames) > 0 && e.ResolveNames[0] != "" {
		return e.ResolveNames[0]
	}
	return "github.com"
}

// probeContainerName is a new test container's name.
func probeContainerName() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return brand.Slug + "-dnscheck-" + hex.EncodeToString(b[:])
}

// lookupDNS runs the lookup with image (the resolv.conf test container's;
// "" when there is none). dockerErr is why Docker could not be read, nil
// when it could.
func (e *Env) lookupDNS(ctx context.Context, image string, dockerErr error) dnsLookup {
	l := dnsLookup{Name: e.lookupName(), Network: cmp.Or(e.lookupNetwork, docker.EdgeNetwork), Image: image}
	switch {
	case dockerErr != nil:
		l.Skipped = fmt.Sprintf("no lookup from a test container: Docker is not reachable (%v)", dockerErr)
		return l
	case image == "":
		l.Skipped = lookupNoImage
		return l
	}
	ctx, cancel := context.WithTimeout(ctx, lookupTimeout)
	defer cancel()
	if _, err := e.dockerCLI(ctx, "network", "inspect", "--format", "{{.Name}}", l.Network); err != nil {
		msg := commandMessage(err)
		if low := strings.ToLower(msg); strings.Contains(low, "not found") || strings.Contains(low, "no such network") {
			l.Skipped = "no lookup from a test container: there is no " + l.Network + " network yet (the agent creates it when it starts)"
		} else {
			l.Skipped = "no lookup from a test container: the " + l.Network + " network could not be read: " + msg
		}
		return l
	}
	name := probeContainerName()
	// Like every container we create, out of a Docker-provider Traefik's
	// sight (Wings').
	args := []string{"run", "--rm", "--name", name, "--pull", "never", "--network", l.Network,
		"--label", docker.LabelDNSCheck + "=true", "--label", docker.LabelTraefikEnable + "=false"}
	for _, s := range e.lookupServers {
		args = append(args, "--dns", s)
	}
	args = append(args, "--entrypoint", "sh", image, "-c", lookupScript, "sh", l.Name)
	out, err := e.dockerCLI(ctx, args...)
	if err != nil {
		// --rm removes a container only after it ran: one cut off between
		// create and start, or by the timeout, stays. ctx may be the one
		// that expired.
		rmCtx, rmCancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		_, _ = e.dockerCLI(rmCtx, "rm", "-f", name)
		rmCancel()
		if ctx.Err() != nil {
			l.Skipped = fmt.Sprintf("no lookup from a test container: Docker did not run it within %s", lookupTimeout)
		} else {
			l.Skipped = "no lookup from a test container: the test container from " + image + " did not run on " + l.Network + ": " + commandMessage(err)
		}
		return l
	}
	took, exit, lines, rc, ok := parseLookupOutput(out)
	switch {
	case !ok:
		l.Skipped = "no lookup from a test container: its output could not be read"
		return l
	case exit == 127:
		l.Skipped = "no lookup from a test container: " + image + " has no nslookup"
		return l
	}
	l.Address, l.Error = nslookupAnswer(lines)
	if exit == 1 && l.Address == "" && l.Error == "" && nslookupRejected(lines) {
		l.Skipped = "no lookup from a test container: " + image + "'s nslookup does not take -type and -timeout (an older or minimal busybox)"
		return l
	}
	l.Took, l.RC = took, rc
	if l.Address == "" && l.Error == "" {
		l.Error = "no address in the answer"
		if exit != 0 {
			l.Error = "nslookup exited with status " + strconv.Itoa(exit)
		}
	}
	return l
}

// parseLookupOutput reads lookupScript's output: nslookup's lines between
// "@start" and "@exit", the time between the two uptimes, the container's
// resolv.conf after "@resolv.conf". ok is false when a marker is missing.
func parseLookupOutput(out string) (took time.Duration, exit int, lines []string, rc *resolvConf, ok bool) {
	var start, end float64
	var haveStart, haveExit, haveEnd, inLookup bool
	before, conf, haveConf := strings.Cut(out, "\n@resolv.conf\n")
	for line := range strings.SplitSeq(before, "\n") {
		line = strings.TrimRight(line, "\r")
		switch {
		case strings.HasPrefix(line, "@start "):
			start, haveStart = parseUptime(strings.TrimPrefix(line, "@start "))
			inLookup = haveStart
		case strings.HasPrefix(line, "@exit "):
			n, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "@exit ")))
			exit, haveExit, inLookup = n, err == nil, false
		case strings.HasPrefix(line, "@end "):
			end, haveEnd = parseUptime(strings.TrimPrefix(line, "@end "))
		case inLookup:
			lines = append(lines, line)
		}
	}
	if !haveStart || !haveExit || !haveEnd || end < start {
		return 0, 0, nil, nil, false
	}
	if haveConf {
		parsed := parseResolvConf(conf)
		rc = &parsed
	}
	return time.Duration((end - start) * float64(time.Second)).Round(10 * time.Millisecond), exit, lines, rc, true
}

func parseUptime(s string) (float64, bool) {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return v, err == nil && v >= 0
}

// nslookupRejected says whether nslookup refused to run, from its output
// when it exited 1 with no error line of its own: busybox's nslookup
// before 1.29 (and a later one built without FEATURE_NSLOOKUP_BIG) takes
// no options, so for -type and -timeout it prints "Usage: nslookup [HOST]
// [SERVER]" (only its banner, or nothing, without its usage texts) and
// exits 1, never asking a server. A lookup that ran says "Server:" first.
func nslookupRejected(lines []string) bool {
	for _, line := range lines {
		t := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(t, "Usage:"):
			return true
		case strings.HasPrefix(t, "Server:"):
			return false
		}
	}
	return true
}

// nslookupAnswer reads busybox nslookup's output: the first address after
// the answer's "Name:" line (the "Address:" before it is the server's),
// else its first error line (";; connection timed out; no servers could
// be reached", "** server can't find github.com: SERVFAIL"), without the
// leading marks.
func nslookupAnswer(lines []string) (address, errText string) {
	afterName := false
	for _, line := range lines {
		t := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(t, "Name:"):
			afterName = true
		case afterName && strings.HasPrefix(t, "Address"):
			// "Address: 140.82.121.4" (also "Address: 2001:db8::1").
			if _, v, ok := strings.Cut(t, ":"); ok && address == "" {
				if f := strings.Fields(v); len(f) > 0 {
					if a, err := netip.ParseAddr(f[0]); err == nil {
						address = a.String()
					}
				}
			}
		case errText == "" && (strings.HasPrefix(t, ";;") || strings.HasPrefix(t, "**") || strings.HasPrefix(t, "nslookup:")):
			errText = strings.TrimSpace(strings.TrimLeft(t, ";* "))
		}
	}
	if address != "" {
		errText = ""
	}
	return address, errText
}

// lookupTime shows a lookup's time: milliseconds below a second, tenths
// of seconds above.
func lookupTime(d time.Duration) string {
	switch {
	case d < 10*time.Millisecond:
		return "under 10 ms"
	case d < time.Second:
		return fmt.Sprintf("%d ms", d.Milliseconds())
	}
	return fmt.Sprintf("%.1f s", d.Seconds())
}

// upstream are the servers the lookup went to: the ones Docker's embedded
// DNS forwards to (its ExtServers note, host(<address>) for one it asks
// from the host's network namespace), or the container's own servers.
// Nil when the container's file does not say.
func (l dnsLookup) upstream() []string {
	if l.RC == nil {
		return nil
	}
	if len(l.RC.Servers) != 1 || l.RC.Servers[0] != embeddedDNS {
		return l.RC.Servers
	}
	out := make([]string, 0, len(l.RC.ExtServers))
	for _, s := range l.RC.ExtServers {
		if inner, ok := strings.CutPrefix(s, "host("); ok {
			s = strings.TrimSuffix(inner, ")")
		}
		out = append(out, s)
	}
	return out
}

// via says which way the lookup went.
func (l dnsLookup) via() string {
	rc := l.RC
	switch {
	case rc == nil:
		return ""
	case len(rc.Servers) != 1 || rc.Servers[0] != embeddedDNS:
		return " through " + serversText(rc.Servers)
	case rc.ExtServers == nil:
		return " through Docker's embedded DNS (" + embeddedDNS + ")"
	case len(rc.ExtServers) == 0:
		return " through Docker's embedded DNS, which has no server to forward to"
	}
	texts := make([]string, len(rc.ExtServers))
	for i, s := range rc.ExtServers {
		texts[i] = nsText(s)
		if inner, ok := strings.CutPrefix(s, "host("); ok {
			texts[i] = strings.TrimSuffix(inner, ")") + " (asked from the host)"
		}
	}
	return " through Docker's embedded DNS, which forwards to " + strings.Join(texts, ", ")
}

// status is what the lookup alone says.
func (l dnsLookup) status() agentv1.NodeCheckStatus {
	switch {
	case l.Skipped != "":
		return agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS
	case l.Address == "":
		return agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL
	case l.Took >= slowLookup:
		return agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN
	}
	return agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS
}

// text is the lookup for the check's detail.
func (l dnsLookup) text() string {
	if l.Skipped != "" {
		return l.Skipped
	}
	who := "a test container on " + l.Network
	switch l.status() {
	case agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL:
		return fmt.Sprintf("%s could not resolve %s%s: %s (after %s)", who, l.Name, l.via(), l.Error, lookupTime(l.Took))
	case agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN:
		return fmt.Sprintf("%s resolved %s%s, but slowly: in %s", who, l.Name, l.via(), lookupTime(l.Took))
	}
	return fmt.Sprintf("%s resolved %s in %s%s", who, l.Name, lookupTime(l.Took), l.via())
}

var statusRank = map[agentv1.NodeCheckStatus]int{
	agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS: 0,
	agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN: 1,
	agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL: 2,
}

// withLookup adds the lookup to r, what the servers' reading found. A
// lookup that is worse leads the detail, sets the status and puts its
// hint first; otherwise it follows the reading, whose hint says why.
func (f dnsFindings) withLookup(r *agentv1.NodeCheckResult) {
	l := f.Lookup
	if l.Skipped != "" {
		if l.Skipped != lookupNoImage && !strings.Contains(r.Detail, l.Skipped) {
			r.Detail += "; " + l.Skipped
		}
		return
	}
	if statusRank[l.status()] <= statusRank[r.Status] {
		r.Detail += "; " + l.text()
		return
	}
	r.Status = l.status()
	r.Detail = l.text() + "; " + r.Detail
	hint := f.lookupFix()
	if r.FixHint != "" {
		hint += " " + r.FixHint
	}
	r.FixHint = hint
}

// lookupFix is the hint for a lookup that failed or was slow while the
// servers containers get are fine: they do not answer from this node, or
// late. It names the servers, how to try them from the node, the
// firewalls that drop DNS, and where to give Docker other servers.
func (f dnsFindings) lookupFix() string {
	l := f.Lookup
	servers := l.upstream()
	var b strings.Builder
	try, n := "the servers", 2
	if len(servers) > 0 {
		try, n = serversText(servers), len(servers)
	}
	dig := "`dig " + l.Name + "`"
	if len(servers) > 0 && classifyNS(servers[0]) != nsInvalid {
		dig = "`dig @" + servers[0] + " " + l.Name + "`"
	}
	if l.status() == agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN {
		fmt.Fprintf(&b, "A lookup usually takes well under 100 ms; a slow one means %s %s late or %s some queries, so a lookup waits for a resend or the next server, and every new connection of an app that does not cache DNS waits that long. "+
			"Check on the node how fast %s %s (%s, a few times) and whether a firewall limits DNS (port 53) to %s. ",
			try, plural(n, "answers", "answer"), plural(n, "drops", "drop"), plural(n, "it", "they"), plural(n, "answers", "answer"), dig, plural(n, "it", "them"))
	} else {
		fmt.Fprintf(&b, "Check on the node that %s %s (%s). When %s %s not, something drops DNS (port 53) on the way: the node's firewall, or the hosting provider's, some of which limit how many DNS sessions a server opens and then block it. ",
			try, plural(n, "answers", "answer"), dig, plural(n, "it", "they"), plural(n, "does", "do"))
	}
	file := f.Config.File
	if file == "" {
		file = "/etc/docker/daemon.json"
	}
	fmt.Fprintf(&b, `To use servers that answer from this node, put them in %s ("dns": [...]) and restart Docker (`+"`systemctl restart docker`"+`), which reads it only when it starts. `, file)
	b.WriteString(f.restartText())
	return strings.TrimSpace(b.String())
}
