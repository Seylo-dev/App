package nodecheck

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/build"
	"github.com/seylo-dev/app/go/internal/docker"
)

// The Container DNS check (docker.dns): Docker gives containers DNS
// servers they can use.
//
// Docker writes every container's /etc/resolv.conf. Without a "dns"
// setting it copies the host's servers (systemd-resolved's real ones when
// the host has 127.0.0.53, Google's when only loopback ones are left); a
// "dns" setting (daemon.json or dockerd --dns) replaces them for every
// container. Two things leave containers with "nameserver invalid IP"
// lines and "# Overrides: [nameservers]":
//
//   - a reload on Docker 29.0 to 29.2 (systemctl reload docker, or a
//     SIGHUP), with a setting that is fine: since 29.0 its entries are
//     netip.Addr values, and the reload deep-copies the daemon's config
//     with copystructure, which zeroes them; a zero netip.Addr prints
//     "invalid IP" (moby#52060, fixed in Docker 29.3.0). Every container
//     created after the reload gets one "invalid IP" per entry until a
//     full restart reads the setting again, and keeps it until it is
//     restarted itself. That is how a node's builds all failed: valid
//     servers in daemon.json, and a reload to turn on live-restore.
//   - entries that are not addresses: Docker 29 starts with an empty ""
//     entry in daemon.json (dockerd --validate accepts it too) and writes
//     "nameserver invalid IP" for it (Docker 29.5 in the test VM); Docker
//     28 refuses to start the container ("bad nameserver address <nil>").
//
// A container on the default bridge, where the build worker runs, then
// has no server, and BuildKit (Go) falls back to [::1]:53:
// "lookup registry-1.docker.io on [::1]:53: ... connection refused". Apps
// on their project networks ask Docker's embedded DNS, which forwards to
// the same servers, so their outside lookups fail too.
//
// What the check reads, most reliable first:
//
//   - a test container on the default bridge (`docker run --rm --name
//     seylo-dnscheck-<random> --pull never --network bridge --label
//     seylo.dnscheck=true --entrypoint cat <image> /etc/resolv.conf`): what
//     Docker gives a new container now, where new build workers run. Only
//     an image already on the node is used (probeRepos); none is pulled,
//     like every other check. It runs with every health check (hourly, and
//     Run checks now) and is gone in well under a second; one a cut-off
//     run left behind is removed by its label.
//   - our running containers' resolv.conf, read from the file Docker
//     mounts into each (<DockerRootDir>/containers/<id>/resolv.conf): the
//     build workers and every seylo.managed container (apps, Traefik, the
//     panel). A container keeps the servers it started with, also after a
//     fix and through a Docker restart with live-restore on; on a project
//     network the file's "# ExtServers:" note (Docker 25 and later) names
//     the servers the embedded DNS forwards to.
//   - to say where the servers come from: the host dockerd's command line
//     (its pid file, docker.service's MainPID, else a dockerd in this PID
//     and user namespace, else docker.service's ExecStart) for --dns and
//     --config-file, and daemon.json at that path (an edit there applies
//     at Docker's next restart). GET /info has no DNS field; its
//     ServerVersion says whether a reload can explain "invalid IP" for a
//     setting that is fine now.
//
// It never changes daemon.json or restarts Docker: a restart stops every
// container on the server unless live-restore is on, Wings' game servers
// too, so the fix hint says how and leaves it to the person. On Docker
// 29.0 to 29.2 with a "dns" setting it never suggests a reload without
// the restart right after it.
//
// Build workers are the agent's own, and a restart keeps their cache: in
// the agent's run (Env.RestartWorkers) the check restarts one that has no
// usable server while the test container gets one, when no build runs on
// it, and says so. Before each build the build service does the same with
// this code (WorkerDNS). While new containers get no server either,
// neither restarts anything.

// containerDNSTitle is the check's title. The build log names it after a
// failed name lookup (build.DNSHint).
const containerDNSTitle = "Container DNS"

// probeRepos are images that have cat, in the order the check uses them:
// BuildKit's (on every node that built something), the agent's Traefik
// and two small bases.
var probeRepos = []string{"moby/buildkit", "traefik", "alpine", "busybox"}

// buildWorkerPrefix starts the container names of our build workers:
// buildx names a docker-container builder's container
// buildx_buildkit_<builder>0.
func buildWorkerPrefix() string { return "buildx_buildkit_" + build.BuilderPrefix + "-" }

// nsKind sorts one DNS server entry.
type nsKind int

const (
	nsUsable nsKind = iota
	// nsLoopback is a loopback or unspecified address: in a container on a
	// bridge network that is the container itself, where no server runs.
	nsLoopback
	// nsInvalid is not an IP address: "", a host name, an address with a
	// port, Docker's "invalid IP".
	nsInvalid
)

func classifyNS(s string) nsKind {
	addr, err := netip.ParseAddr(s)
	switch {
	case err != nil:
		return nsInvalid
	case addr.IsLoopback() || addr.IsUnspecified():
		return nsLoopback
	}
	return nsUsable
}

// nsText shows a server: as it is when it is an IP address, quoted when
// not (so "" and "invalid IP" read as values).
func nsText(s string) string {
	if classifyNS(s) == nsInvalid {
		return strconv.Quote(s)
	}
	return s
}

// dnsVerdict is what a list of servers means for a container.
type dnsVerdict int

const (
	dnsOK dnsVerdict = iota
	// dnsSome: usable servers next to ones that are not. Lookups work (the
	// resolvers skip what they cannot use), the setting is still wrong.
	dnsSome
	// dnsIPv6Only: only IPv6 servers while Docker's bridge has no IPv6.
	dnsIPv6Only
	// dnsNone: no server a container can use.
	dnsNone
)

func judgeServers(servers []string, ipv6 bool) dnsVerdict {
	usable, v4 := 0, false
	for _, s := range servers {
		if classifyNS(s) != nsUsable {
			continue
		}
		usable++
		if addr, _ := netip.ParseAddr(s); addr.Unmap().Is4() {
			v4 = true
		}
	}
	switch {
	case usable == 0:
		return dnsNone
	case !v4 && !ipv6:
		return dnsIPv6Only
	case usable < len(servers):
		return dnsSome
	}
	return dnsOK
}

// resolvConf is what a container's /etc/resolv.conf says.
type resolvConf struct {
	// Servers are the nameserver values as written ("invalid IP" too).
	Servers []string
	// HostFile is the host file Docker started from ("# Based on host
	// file: '<path>'").
	HostFile string
	// Override is Docker's "# Overrides: [nameservers]" note: the servers
	// come from its "dns" setting, not from the host.
	Override bool
	// ExtServers are the servers Docker's embedded DNS forwards to for a
	// container on a user-defined network (nameserver 127.0.0.11), from
	// Docker's "# ExtServers: [...]" note (Docker 25 and later):
	// host(<address>) for one asked from the host's network namespace.
	// Nil without the note.
	ExtServers []string
}

// embeddedDNS is Docker's embedded DNS server, the only nameserver of a
// container on a user-defined network.
const embeddedDNS = "127.0.0.11"

// invalidIP is how Docker writes a server that is no address (netip's
// zero Addr).
const invalidIP = "invalid IP"

// dnsReloadFixed is the first Docker release whose reload keeps the "dns"
// setting (moby#52060).
const dnsReloadFixed = "29.3.0"

// dnsReloadBug reports whether Docker version v loses its "dns" setting
// when it is reloaded: from 29.0.0 (moby#50600 made the entries netip.Addr
// values) up to, not including, 29.3.0 (moby#52060).
func dnsReloadBug(v string) bool {
	major, minor, ok := parseDockerVersion(v)
	return ok && major == 29 && minor < 3
}

// settingServers are the servers a container got from Docker's "dns"
// setting: its nameserver lines, or on a user-defined network the ones
// the embedded DNS forwards to (Docker's ExtServers note).
func (rc resolvConf) settingServers() []string {
	if len(rc.Servers) == 1 && rc.Servers[0] == embeddedDNS {
		return rc.ExtServers
	}
	return rc.Servers
}

// allInvalidIP: the container's servers come from Docker's "dns" setting
// (the Overrides note) and every one is "invalid IP", which is what
// Docker 29.0 to 29.2 gives a container created after a reload.
func (rc resolvConf) allInvalidIP() bool {
	servers := rc.settingServers()
	return rc.Override && len(servers) > 0 && !slices.ContainsFunc(servers, func(s string) bool { return s != invalidIP })
}

// lookupsWork reports whether a container with this file has a server
// for outside names; known is false when the file does not say (the
// embedded DNS without Docker's ExtServers note).
func (rc resolvConf) lookupsWork() (works, known bool) {
	if len(rc.Servers) != 1 || rc.Servers[0] != embeddedDNS {
		return judgeServers(rc.Servers, true) != dnsNone, true
	}
	if rc.ExtServers == nil {
		return false, false
	}
	for _, s := range rc.ExtServers {
		if inner, ok := strings.CutPrefix(s, "host("); ok {
			// Asked from the host's network namespace, where a loopback
			// address is the host's own server.
			if _, err := netip.ParseAddr(strings.TrimSuffix(inner, ")")); err == nil {
				return true, true
			}
			continue
		}
		if classifyNS(s) == nsUsable {
			return true, true
		}
	}
	return false, true
}

func parseResolvConf(data string) resolvConf {
	var rc resolvConf
	for line := range strings.SplitSeq(data, "\n") {
		line = strings.TrimSpace(line)
		if rest, ok := strings.CutPrefix(line, "# Based on host file:"); ok {
			if _, quoted, ok := strings.Cut(rest, "'"); ok {
				rc.HostFile, _, _ = strings.Cut(quoted, "'")
			}
			continue
		}
		if rest, ok := strings.CutPrefix(line, "# Overrides:"); ok {
			rc.Override = strings.Contains(rest, "nameservers")
			continue
		}
		if rest, ok := strings.CutPrefix(line, "# ExtServers:"); ok {
			rest = strings.TrimSpace(rest)
			rest = strings.TrimSuffix(strings.TrimPrefix(rest, "["), "]")
			// "invalid IP" has a space: keep it one entry.
			rest = strings.ReplaceAll(rest, invalidIP, strings.ReplaceAll(invalidIP, " ", "\x00"))
			rc.ExtServers = []string{}
			for _, f := range strings.Fields(rest) {
				rc.ExtServers = append(rc.ExtServers, strings.ReplaceAll(f, "\x00", " "))
			}
			continue
		}
		if f := strings.Fields(line); len(f) > 0 && f[0] == "nameserver" {
			rc.Servers = append(rc.Servers, strings.Join(f[1:], " "))
		}
	}
	return rc
}

// sameServers reports whether a container's servers are the setting's,
// an entry that is not an IP address standing for any one that is not
// (Docker writes "invalid IP" for it).
func sameServers(container, setting []string) bool {
	return slices.EqualFunc(container, setting, func(c, s string) bool {
		if classifyNS(s) == nsInvalid {
			return classifyNS(c) == nsInvalid
		}
		return c == s
	})
}

func serversText(servers []string) string {
	if len(servers) == 0 {
		return "no nameserver line"
	}
	texts := make([]string, len(servers))
	for i, s := range servers {
		texts[i] = nsText(s)
	}
	return strings.Join(texts, ", ")
}

// dnsEntry is one server of Docker's "dns" setting.
type dnsEntry struct {
	// Text is the entry as written: 1.1.1.1, "" or null.
	Text string
	// Server is the value a container gets, "" for a non-string entry.
	Server string
	Kind   nsKind
}

func entryOf(s string) dnsEntry { return dnsEntry{Text: nsText(s), Server: s, Kind: classifyNS(s)} }

// dnsSource is one place that sets Docker's "dns": daemon.json or
// dockerd's --dns flags.
type dnsSource struct {
	Where   string
	Flags   bool
	Entries []dnsEntry
}

// place says where the setting is: `"dns" in /etc/docker/daemon.json`.
func (s dnsSource) place() string {
	if s.Flags {
		return "--dns on " + s.Where
	}
	return `"dns" in ` + s.Where
}

func (s dnsSource) String() string {
	texts := make([]string, len(s.Entries))
	for i, e := range s.Entries {
		texts[i] = e.Text
	}
	if s.Flags {
		return "--dns " + strings.Join(texts, " --dns ") + " on " + s.Where
	}
	return `"dns": [` + strings.Join(texts, ", ") + "] in " + s.Where
}

// daemonDNS is what dockerd was told about DNS.
type daemonDNS struct {
	// File is the daemon.json the daemon reads: --config-file, else
	// /etc/docker/daemon.json.
	File string
	// Sources are the places that set "dns"; none when Docker uses the
	// host's servers.
	Sources []dnsSource
	// ArgsFrom says where dockerd's command line was read, "" when it
	// could not be.
	ArgsFrom string
	// FileRead: File was read, or does not exist.
	FileRead bool
	// IPv6: Docker's bridge has IPv6 ("ipv6": true or --ipv6).
	IPv6 bool
	// Broken is why File does not parse: Docker does not start with it.
	Broken string
	// Unread lists what could not be read.
	Unread []string
}

func (d daemonDNS) entries() []dnsEntry {
	var out []dnsEntry
	for _, s := range d.Sources {
		out = append(out, s.Entries...)
	}
	return out
}

func (d daemonDNS) servers() []string {
	var out []string
	for _, e := range d.entries() {
		out = append(out, e.Server)
	}
	return out
}

func (d daemonDNS) String() string {
	parts := make([]string, len(d.Sources))
	for i, s := range d.Sources {
		parts[i] = s.String()
	}
	return strings.Join(parts, " and ")
}

// place says where the setting is.
func (d daemonDNS) place() string {
	parts := make([]string, len(d.Sources))
	for i, s := range d.Sources {
		parts[i] = s.place()
	}
	return strings.Join(parts, " and ")
}

// why says what is wrong with the setting's entries, "" when nothing is.
func (d daemonDNS) why() string {
	var invalid, loopback []string
	for _, e := range d.entries() {
		switch e.Kind {
		case nsInvalid:
			invalid = append(invalid, e.Text)
		case nsLoopback:
			loopback = append(loopback, e.Text)
		}
	}
	var parts []string
	if len(invalid) > 0 {
		parts = append(parts, strings.Join(invalid, ", ")+" "+plural(len(invalid), "is not an IP address", "are not IP addresses"))
	}
	if len(loopback) > 0 {
		parts = append(parts, strings.Join(loopback, ", ")+" "+plural(len(loopback), "is a loopback address", "are loopback addresses")+
			", which in a container is the container itself")
	}
	return strings.Join(parts, "; ")
}

// cause is the setting and what is wrong with it, for a detail.
func (d daemonDNS) cause() string {
	if len(d.Sources) == 0 {
		return ""
	}
	if why := d.why(); why != "" {
		return d.String() + " (" + why + ")"
	}
	return d.String()
}

// kinds says whether dockerd's --dns flags and daemon.json set "dns".
func (d daemonDNS) kinds() (flags, file bool) {
	return slices.ContainsFunc(d.Sources, func(s dnsSource) bool { return s.Flags }),
		slices.ContainsFunc(d.Sources, func(s dnsSource) bool { return !s.Flags })
}

// rereads says where a restarted dockerd reads the setting again from.
func (d daemonDNS) rereads() string {
	switch flags, file := d.kinds(); {
	case flags && file:
		return "reads " + d.File + " and dockerd's --dns flags again"
	case flags:
		return "starts dockerd with its --dns flags again"
	}
	return "reads " + d.File + " again"
}

func (e *Env) daemonDNS(ctx context.Context) daemonDNS {
	d := daemonDNS{File: filepath.Join(e.EtcDir, "docker", "daemon.json")}
	if args, from := e.dockerdArgs(ctx); from != "" {
		d.ArgsFrom = from
		flags := parseDockerdFlags(args)
		if flags.configFile != "" {
			d.File = flags.configFile
		}
		d.IPv6 = flags.ipv6
		if len(flags.dns) > 0 {
			src := dnsSource{Where: from, Flags: true}
			for _, s := range flags.dns {
				src.Entries = append(src.Entries, entryOf(s))
			}
			d.Sources = append(d.Sources, src)
		}
	} else {
		d.Unread = append(d.Unread, "dockerd's command line")
	}
	data, err := os.ReadFile(d.File)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		d.FileRead = true
	case err != nil:
		var pe *fs.PathError
		if errors.As(err, &pe) {
			err = pe.Err
		}
		d.Unread = append(d.Unread, fmt.Sprintf("%s (%v)", d.File, err))
	default:
		d.FileRead = true
		entries, set, ipv6, err := parseDaemonJSON(data)
		if err != nil {
			d.Broken = err.Error()
			break
		}
		d.IPv6 = d.IPv6 || ipv6
		if set && len(entries) > 0 {
			d.Sources = append(d.Sources, dnsSource{Where: d.File, Entries: entries})
		}
	}
	return d
}

// parseDaemonJSON reads daemon.json's "dns" (set: the key is there) and
// "ipv6". Entries are kept as written: an empty string starts Docker 29
// with "nameserver invalid IP" for it, and null or a number is no server
// either.
func parseDaemonJSON(data []byte) (entries []dnsEntry, set, ipv6 bool, err error) {
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, false, false, err
	}
	if raw, ok := doc["ipv6"]; ok {
		_ = json.Unmarshal(raw, &ipv6)
	}
	raw, set := doc["dns"]
	if !set {
		return nil, false, ipv6, nil
	}
	var list []json.RawMessage
	if json.Unmarshal(raw, &list) != nil {
		// Not a list ("dns": "1.1.1.1"): Docker reads no server from it.
		return []dnsEntry{{Text: string(bytes.TrimSpace(raw)), Kind: nsInvalid}}, true, ipv6, nil
	}
	for _, item := range list {
		item = bytes.TrimSpace(item)
		var s string
		if string(item) == "null" || json.Unmarshal(item, &s) != nil {
			entries = append(entries, dnsEntry{Text: string(item), Kind: nsInvalid})
			continue
		}
		entries = append(entries, entryOf(s))
	}
	return entries, true, ipv6, nil
}

// dockerdFlags are the flags of dockerd's command line the check reads.
type dockerdFlags struct {
	dns        []string
	configFile string
	ipv6       bool
}

func parseDockerdFlags(args []string) dockerdFlags {
	var f dockerdFlags
	for i := 0; i < len(args); i++ {
		name, value, inline := strings.Cut(args[i], "=")
		if (name == "--dns" || name == "--config-file") && !inline {
			if i+1 >= len(args) {
				break
			}
			i++
			value = args[i]
		}
		switch name {
		case "--dns":
			f.dns = append(f.dns, value)
		case "--config-file":
			f.configFile = value
		case "--ipv6":
			f.ipv6 = !inline || value == "true"
		}
	}
	return f
}

// dockerdArgs is the host dockerd's command line, from where it is surest
// to be the host's own daemon and not a second dockerd (a docker:dind
// container's, another user's rootless one: /proc shows them all, and
// their pids may sort first): the pid in dockerd's pid file
// (/var/run/docker.pid), docker.service's MainPID, else a dockerd process
// in this PID and user namespace, else docker.service's ExecStart when no
// dockerd process can be read (/proc with hidepid, a run without root).
// from says which; "" when none could be read.
func (e *Env) dockerdArgs(ctx context.Context) (args []string, from string) {
	fromPID := func(pid string) string { return "dockerd's command line (pid " + pid + ")" }
	if data, err := e.read(filepath.Join(e.RunDir, "docker.pid")); err == nil {
		pid := strings.TrimSpace(data)
		if args, ok := e.dockerdCmdline(pid); ok {
			return args, fromPID(pid)
		}
	}
	if out, err := e.output(ctx, "systemctl", "show", "--property=MainPID", "--value", "docker.service"); err == nil {
		pid := strings.TrimSpace(out)
		if args, ok := e.dockerdCmdline(pid); ok {
			return args, fromPID(pid)
		}
	}
	if pid, args := e.findDockerd(); pid != "" {
		return args, fromPID(pid)
	}
	out, err := e.output(ctx, "systemctl", "show", "--property=ExecStart", "docker.service")
	if err != nil {
		return nil, ""
	}
	if args := parseExecStart(out); len(args) > 0 {
		return args, "docker.service's ExecStart"
	}
	return nil, ""
}

// dockerdCmdline is process pid's command line when it is a dockerd (a
// stale pid file can name another process).
func (e *Env) dockerdCmdline(pid string) ([]string, bool) {
	if n, err := strconv.Atoi(pid); err != nil || n <= 0 {
		return nil, false
	}
	if comm, err := e.read(filepath.Join(e.ProcDir, pid, "comm")); err != nil || strings.TrimSpace(comm) != "dockerd" {
		return nil, false
	}
	cmdline, err := e.read(filepath.Join(e.ProcDir, pid, "cmdline"))
	if err != nil || strings.Trim(cmdline, "\x00") == "" {
		return nil, false
	}
	return strings.Split(strings.TrimRight(cmdline, "\x00"), "\x00"), true
}

// findDockerd looks through /proc for a dockerd. One in another PID or
// user namespace than this process is not the host's; of the rest, one
// known to share both comes first, then the lowest pid (the host's daemon
// starts with the server).
func (e *Env) findDockerd() (pid string, args []string) {
	entries, _ := os.ReadDir(e.ProcDir)
	self := e.namespaces("self")
	bestPID, bestSame := 0, -1
	for _, entry := range entries {
		n, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		a, ok := e.dockerdCmdline(entry.Name())
		if !ok {
			continue
		}
		same := sameNamespaces(self, e.namespaces(entry.Name()))
		if same < 0 {
			continue
		}
		if same > bestSame || (same == bestSame && n < bestPID) {
			pid, args, bestPID, bestSame = entry.Name(), a, n, same
		}
	}
	return pid, args
}

// namespaces are a process's PID and user namespaces as /proc/<pid>/ns
// links name them ("pid:[4026531836]"), "" where one cannot be read (it
// needs root for another user's process).
func (e *Env) namespaces(pid string) [2]string {
	var ns [2]string
	for i, kind := range []string{"pid", "user"} {
		ns[i], _ = os.Readlink(filepath.Join(e.ProcDir, pid, "ns", kind))
	}
	return ns
}

// sameNamespaces is 1 when both processes are known to share their PID
// and user namespaces, -1 when one is known to differ, 0 when it cannot be
// told.
func sameNamespaces(a, b [2]string) int {
	known := 0
	for i := range a {
		if a[i] == "" || b[i] == "" {
			continue
		}
		if a[i] != b[i] {
			return -1
		}
		known++
	}
	if known == len(a) {
		return 1
	}
	return 0
}

// parseExecStart reads `systemctl show --property=ExecStart`:
//
//	ExecStart={ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd -H fd:// --dns 1.1.1.1 ; ignore_errors=no ; ... }
func parseExecStart(out string) []string {
	_, rest, ok := strings.Cut(out, "argv[]=")
	if !ok {
		return nil
	}
	argv, _, _ := strings.Cut(rest, " ;")
	return strings.Fields(argv)
}

// dnsProbe is the test container's resolv.conf, or why there is none.
type dnsProbe struct {
	Image string
	RC    *resolvConf
	// Refused is Docker's error when it would not start the container
	// over its DNS servers (before Docker 29: "bad nameserver address").
	Refused string
	// Skipped says why no container ran.
	Skipped string
}

// pickProbeImage picks the first of probeRepos in `docker image ls
// --format {{.Repository}}:{{.Tag}}`.
func pickProbeImage(list string) string {
	best, rank := "", len(probeRepos)
	for _, ref := range strings.Fields(list) {
		i := strings.LastIndexByte(ref, ':')
		if i < 0 || i < strings.LastIndexByte(ref, '/') {
			continue
		}
		repo, tag := ref[:i], ref[i+1:]
		if tag == "" || tag == "<none>" {
			continue
		}
		repo = strings.TrimPrefix(strings.TrimPrefix(repo, "docker.io/"), "library/")
		if n := slices.Index(probeRepos, repo); n >= 0 && n < rank {
			best, rank = ref, n
		}
	}
	return best
}

// dockerCLI runs docker the way builds do (DOCKER_CONFIG under the builds
// folder): the daemon builds use, never a context of root's ~/.docker.
// Run takes no environment, so env(1) sets it.
func (e *Env) dockerCLI(ctx context.Context, args ...string) (string, error) {
	return e.output(ctx, "env", append([]string{"DOCKER_CONFIG=" + e.layout().BuildsDockerConfig(), "DOCKER_CLI_HINTS=false", "docker"}, args...)...)
}

// probeTimeout bounds the test container's run, and probeLeftoverAge is
// how old a test container must be before a later run removes it (older
// than any run, so never another run's that is still going).
const (
	probeTimeout     = 30 * time.Second
	probeLeftoverAge = 2 * time.Minute
)

func (e *Env) probeDNS(ctx context.Context) dnsProbe {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	list, err := e.dockerCLI(ctx, "image", "ls", "--format", "{{.Repository}}:{{.Tag}}")
	if err != nil {
		return dnsProbe{Skipped: "no test container: Docker's images could not be listed"}
	}
	image := pickProbeImage(list)
	if image == "" {
		return dnsProbe{Skipped: "no test container: no " + strings.Join(probeRepos[:len(probeRepos)-1], ", ") + " or " + probeRepos[len(probeRepos)-1] +
			" image on this node, and the check pulls none"}
	}
	e.removeLeftoverProbes(ctx)
	var b [4]byte
	_, _ = rand.Read(b[:])
	name := brand.Slug + "-dnscheck-" + hex.EncodeToString(b[:])
	// Like every container we create, out of a Docker-provider Traefik's
	// sight (Wings').
	out, err := e.dockerCLI(ctx, "run", "--rm", "--name", name, "--pull", "never", "--network", "bridge",
		"--label", docker.LabelDNSCheck+"=true", "--label", docker.LabelTraefikEnable+"=false", "--entrypoint", "cat", image, "/etc/resolv.conf")
	if err != nil {
		// --rm removes a container only after it ran: one cut off between
		// create and start (the timeout, a stuck Docker) or refused at
		// start stays. ctx may be the one that expired.
		rmCtx, rmCancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		_, _ = e.dockerCLI(rmCtx, "rm", "-f", name)
		rmCancel()
		msg := commandMessage(err)
		if strings.Contains(msg, "nameserver") {
			return dnsProbe{Image: image, Refused: msg}
		}
		return dnsProbe{Image: image, Skipped: "the test container from " + image + " did not run: " + msg}
	}
	rc := parseResolvConf(out)
	return dnsProbe{Image: image, RC: &rc}
}

// gives: the test container got a DNS server it can use, so a container
// started now (a restarted build worker too) gets one.
func (p dnsProbe) gives() bool {
	if p.RC == nil {
		return false
	}
	works, _ := p.RC.lookupsWork()
	return works
}

// removeLeftoverProbes removes test containers earlier runs left behind
// (docker.LabelDNSCheck), any state, once they are older than any run.
func (e *Env) removeLeftoverProbes(ctx context.Context) {
	list, err := e.Docker.Containers(ctx, map[string][]string{"label": {docker.LabelDNSCheck}})
	if err != nil {
		return
	}
	var ids []string
	for _, c := range list {
		if c.Labels[docker.LabelDNSCheck] == "" || c.ID == "" || e.Now().Sub(time.Unix(c.Created, 0)) < probeLeftoverAge {
			continue
		}
		ids = append(ids, c.ID)
	}
	if len(ids) > 0 {
		_, _ = e.dockerCLI(ctx, append([]string{"rm", "-f"}, ids...)...)
	}
}

// commandMessage is the command's own message in a Runner error (after
// the command line and the exit status), its first line.
func commandMessage(err error) string {
	msg := err.Error()
	if _, after, ok := strings.Cut(msg, "exit status "); ok {
		if _, m, ok := strings.Cut(after, ": "); ok {
			msg = m
		}
	}
	msg, _, _ = strings.Cut(strings.TrimSpace(msg), "\n")
	if len(msg) > 300 {
		msg = msg[:300]
	}
	return msg
}

// ownContainer is a running container of ours and its resolv.conf.
type ownContainer struct {
	Name string
	// Builder is a build worker's buildx builder; "" for any other.
	Builder string
	// Service: an app's container (reconcile's), restarted from the panel.
	Service bool
	RC      resolvConf
}

// stale: the container is known to have no server for outside names.
func (c ownContainer) stale() bool {
	works, known := c.RC.lookupsWork()
	return known && !works
}

// ownContainers reads our running containers' resolv.conf from the file
// Docker mounts into each (under info's DockerRootDir), so nothing runs in
// them: the build workers and every seylo.managed container with a network
// of its own (not host, none or another container's, whose file is not
// Docker's). filters narrow Docker's list further (a name).
func (e *Env) ownContainers(ctx context.Context, info *DockerInfo, filters map[string][]string) []ownContainer {
	if info == nil || info.DockerRootDir == "" {
		return nil
	}
	query := map[string][]string{"status": {"running"}}
	maps.Copy(query, filters)
	list, err := e.Docker.Containers(ctx, query)
	if err != nil {
		return nil
	}
	prefix := buildWorkerPrefix()
	var out []ownContainer
	for _, c := range list {
		name := c.Name()
		worker := strings.HasPrefix(name, prefix)
		if c.State != "running" || c.ID == "" || strings.ContainsAny(c.ID, `/\.`) || (!worker && !docker.IsManaged(c.Labels)) {
			continue
		}
		if mode := c.HostConfig.NetworkMode; mode == "host" || mode == "none" || strings.HasPrefix(mode, "container:") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(info.DockerRootDir, "containers", c.ID, "resolv.conf"))
		if err != nil {
			continue
		}
		oc := ownContainer{Name: name, RC: parseResolvConf(string(data))}
		if worker {
			// Builder <name> runs in container buildx_buildkit_<name>0
			// (build.WorkerContainer).
			oc.Builder = strings.TrimRight(strings.TrimPrefix(name, "buildx_buildkit_"), "0123456789")
		} else {
			oc.Service = docker.IsServiceInstance(c.Labels)
		}
		out = append(out, oc)
	}
	slices.SortFunc(out, func(a, b ownContainer) int { return strings.Compare(a.Name, b.Name) })
	return out
}

// WorkerDNS judges a build worker's DNS servers with this check's code,
// for the build service (build.Options.WorkerDNS), which restarts a stale
// one before a build uses it.
type WorkerDNS struct{ env *Env }

var _ build.WorkerDNS = (*WorkerDNS)(nil)

// NewWorkerDNS reads Docker the way the checks do (env's Docker, and its
// DataDir for the builds' DOCKER_CONFIG the test container runs with).
func NewWorkerDNS(env Env) *WorkerDNS {
	env.defaults()
	return &WorkerDNS{env: &env}
}

// Worker implements build.WorkerDNS: builder's running worker without a
// usable server (its resolv.conf, as the check reads ours) is stale when
// the check's test container gets one, and Docker gives none when the test
// container does not either or Docker refuses it. The test container runs
// only for a worker without a server.
func (w *WorkerDNS) Worker(ctx context.Context, builder string) build.WorkerDNSState {
	e := w.env
	info, err := e.Docker.Info(ctx)
	if err != nil {
		return build.WorkerDNSOK
	}
	name := build.WorkerContainer(builder)
	list := e.ownContainers(ctx, info, map[string][]string{"name": {"^/" + regexp.QuoteMeta(name) + "$"}})
	if i := slices.IndexFunc(list, func(c ownContainer) bool { return c.Name == name }); i < 0 || !list[i].stale() {
		return build.WorkerDNSOK
	}
	switch p := e.probeDNS(ctx); {
	case p.gives():
		return build.WorkerDNSStale
	case p.RC != nil || p.Refused != "":
		return build.WorkerDNSNoServers
	}
	// No test container ran: whether a restart helps is not known.
	return build.WorkerDNSOK
}

// dnsFindings is everything the check read.
type dnsFindings struct {
	Config daemonDNS
	Probe  dnsProbe
	// Containers are our running containers: build workers, apps, Traefik.
	Containers []ownContainer
	// LiveRestore is Docker's live-restore, nil when Docker is not
	// reachable.
	LiveRestore *bool
	// Version is Docker's ServerVersion, "" when Docker is not reachable.
	Version string
	Wings   bool
	// BuildsConfig is the builds' DOCKER_CONFIG, where the builders are.
	BuildsConfig string
	// Heals: the agent restarts our stale build workers itself
	// (Env.RestartWorkers is set).
	Heals bool
	// Restarted are the build workers the check restarted that have usable
	// servers now; RestartedReload: a reload on this Docker explained what
	// they had (staleReloadLost before the restart).
	Restarted       []string
	RestartedReload bool
}

func (e *Env) containerDNS(ctx context.Context) *agentv1.NodeCheckResult {
	info, err := e.Docker.Info(ctx)
	if err != nil {
		info = nil
	}
	f := dnsFindings{
		Config:       e.daemonDNS(ctx),
		Probe:        e.probeDNS(ctx),
		Containers:   e.ownContainers(ctx, info, nil),
		Wings:        e.wingsInfo(ctx) != nil,
		BuildsConfig: e.layout().BuildsDockerConfig(),
		Heals:        e.RestartWorkers != nil,
	}
	if info != nil {
		f.LiveRestore = &info.LiveRestoreEnabled
		f.Version = info.ServerVersion
	}
	e.restartStaleWorkers(ctx, info, &f)
	return f.result()
}

// restartStaleWorkers restarts our build workers without a usable server
// through Env.RestartWorkers when the test container got one (a restart
// gives them that), then reads our containers again. While the test
// container gets none, or none ran, nothing is restarted.
func (e *Env) restartStaleWorkers(ctx context.Context, info *DockerInfo, f *dnsFindings) {
	stale := f.workers(true)
	if e.RestartWorkers == nil || len(stale) == 0 || !f.Probe.gives() {
		return
	}
	builders := make([]string, len(stale))
	for i, w := range stale {
		builders[i] = w.Builder
	}
	restarted := e.RestartWorkers(ctx, builders)
	if len(restarted) == 0 {
		return
	}
	reload := f.staleReloadLost()
	f.Containers = e.ownContainers(ctx, info, nil)
	for _, w := range stale {
		if !slices.Contains(restarted, w.Builder) {
			continue
		}
		if i := slices.IndexFunc(f.Containers, func(c ownContainer) bool { return c.Name == w.Name }); i < 0 || !f.Containers[i].stale() {
			f.Restarted = append(f.Restarted, w.Name)
		}
	}
	f.RestartedReload = reload && len(f.Restarted) > 0
}

// reloadRisk: there is a "dns" setting and a reload on this Docker
// empties it (moby#52060), so a reload needs a restart right after it.
func (f dnsFindings) reloadRisk() bool {
	return dnsReloadBug(f.Version) && len(f.Config.Sources) > 0
}

// reloadMayExplain: a reload on this Docker gives a container what rc
// has, "invalid IP" for every server of the "dns" setting.
func (f dnsFindings) reloadMayExplain(rc resolvConf) bool {
	return dnsReloadBug(f.Version) && rc.allInvalidIP()
}

// reloadLost: rc's "invalid IP" servers are the "dns" setting read now
// after a reload emptied it: one for each entry, and every entry a usable
// address, so the setting itself does not explain them.
func (f dnsFindings) reloadLost(rc resolvConf) bool {
	entries := f.Config.entries()
	return f.reloadMayExplain(rc) && len(entries) == len(rc.settingServers()) &&
		!slices.ContainsFunc(entries, func(e dnsEntry) bool { return e.Kind != nsUsable })
}

// staleReloadLost: a container of ours without a server has "invalid IP"
// that a reload explains.
func (f dnsFindings) staleReloadLost() bool {
	return slices.ContainsFunc(f.Containers, func(c ownContainer) bool { return c.stale() && f.reloadLost(c.RC) })
}

// reloadText says what a reload does on this Docker, for a detail.
func (f dnsFindings) reloadText() string {
	return fmt.Sprintf(`Docker %s loses its "dns" setting when it is reloaded (systemctl reload docker, or a SIGHUP; moby#52060, fixed in Docker %s)`, f.Version, dnsReloadFixed)
}

// staleReloadText says where our containers' "invalid IP" can come from.
func (f dnsFindings) staleReloadText() string {
	return `a container created after a reload gets "invalid IP" for each of ` + serversText(f.Config.servers()) + " (" + f.Config.place() + "): " + f.reloadText()
}

// reloadSafe is the last sentence of a hint about a reload.
func reloadSafe() string {
	return "Updating Docker to " + dnsReloadFixed + " or later makes reloads safe."
}

// workers are the build workers among the containers; stale only those
// without a server.
func (f dnsFindings) workers(stale bool) []ownContainer {
	return slices.DeleteFunc(slices.Clone(f.Containers), func(c ownContainer) bool { return c.Builder == "" || (stale && !c.stale()) })
}

// staleApps are the other containers of ours without a server.
func (f dnsFindings) staleApps() []ownContainer {
	return slices.DeleteFunc(slices.Clone(f.Containers), func(c ownContainer) bool { return c.Builder != "" || !c.stale() })
}

func names(list []ownContainer) []string {
	out := make([]string, len(list))
	for i, c := range list {
		out[i] = c.Name
	}
	return out
}

const dnsEffect = "builds cannot pull images (the build worker runs on Docker's default bridge) and apps cannot look up names outside this server"

// staleText says which of our containers kept servers they cannot use,
// "" when none did.
func (f dnsFindings) staleText() string {
	var parts []string
	if stale := names(f.workers(true)); len(stale) > 0 {
		n := len(stale)
		parts = append(parts, fmt.Sprintf("%s %s still %s no DNS server %s can use, from before, so builds there cannot pull images",
			plural(n, "the build worker", "the build workers"), strings.Join(stale, ", "), plural(n, "has", "have"), plural(n, "it", "they")))
	}
	if stale := names(f.staleApps()); len(stale) > 0 {
		n := len(stale)
		parts = append(parts, fmt.Sprintf("%s %s still %s no DNS server %s can use, from before, so %s cannot look up names outside this server",
			plural(n, "the container", "the containers"), strings.Join(stale, ", "), plural(n, "has", "have"), plural(n, "it", "they"), plural(n, "it", "they")))
	}
	return strings.Join(parts, ", and ")
}

// result is the check's result, with the build workers the check
// restarted at the end of the detail.
func (f dnsFindings) result() *agentv1.NodeCheckResult {
	r := f.judge()
	if n := len(f.Restarted); n > 0 {
		note := fmt.Sprintf("restarted %s %s, which had no DNS server %s could use, from before: %s now %s the servers new containers get, and %s %s build cache",
			plural(n, "the build worker", "the build workers"), strings.Join(f.Restarted, ", "), plural(n, "it", "they"),
			plural(n, "it", "they"), plural(n, "has", "have"), plural(n, "keeps", "keep"), plural(n, "its", "their"))
		if f.RestartedReload {
			note += "; " + f.reloadText() + ", so restart Docker instead of reloading it"
		}
		r.Detail += "; " + note
	}
	return r
}

func (f dnsFindings) judge() *agentv1.NodeCheckResult {
	cfg := f.Config
	if rc := f.Probe.RC; rc != nil {
		what := fmt.Sprintf("a test container on Docker's default bridge (%s) gets %s", f.Probe.Image, serversText(rc.Servers))
		if f.reloadLost(*rc) {
			detail := "containers get no DNS server they can use: " + what + ", although " + cfg.place() + " gives " + serversText(cfg.servers()) +
				": " + f.reloadText() + "; " + dnsEffect
			if stale := f.staleText(); stale != "" {
				detail += "; " + stale
			}
			return fail(detail, f.reloadFix())
		}
		// The setting as read now is what containers get, or it changed
		// after Docker started and applies at its next restart, or a
		// reload emptied it.
		current := rc.Override && len(cfg.Sources) > 0 && sameServers(rc.Servers, cfg.servers())
		switch {
		case current:
			what += ", from " + cfg.cause()
		case rc.Override && len(cfg.Sources) > 0 && f.reloadMayExplain(*rc):
			what += fmt.Sprintf(`, from Docker's "dns" setting as Docker holds it now (Docker %s empties it when it is reloaded, moby#52060)`, f.Version)
		case rc.Override && len(cfg.Sources) > 0:
			what += `, from Docker's "dns" setting as it was when Docker started`
		case rc.Override:
			what += `, from Docker's "dns" setting`
		case rc.HostFile != "":
			what += ", the host's from " + rc.HostFile
		default:
			what += ", the host's"
		}
		pending := ""
		if len(cfg.Sources) > 0 && !current {
			pending = cfg.String() + " applies once Docker restarts"
		}
		// Without an override Docker drops IPv6 servers from the host's
		// unless its bridge has IPv6, so those it kept are reachable.
		switch judgeServers(rc.Servers, cfg.IPv6 || !rc.Override) {
		case dnsNone:
			detail := "containers get no DNS server they can use: " + what
			if pending != "" {
				detail += "; " + pending
			}
			return fail(detail+"; "+dnsEffect, f.fix())
		case dnsIPv6Only:
			return warn(what+`: only IPv6 servers, and Docker's bridge has no IPv6 ("ipv6": true), so containers on it may not reach them`, f.fix())
		case dnsSome:
			return warn(what+"; containers use the servers that work, but the others should be fixed or removed", f.fix())
		}
		if stale := f.staleText(); stale != "" {
			if f.staleReloadLost() {
				// The test container shows Docker holds the setting again.
				return fail(what+", but "+stale+"; "+f.staleReloadText(), f.staleFix()+fmt.Sprintf(
					" Docker holds the \"dns\" setting again, so it needs no restart now. From now on restart Docker instead of reloading it: on Docker %s a reload empties the \"dns\" setting for every new container until the next restart (moby#52060). %s",
					f.Version, reloadSafe()))
			}
			return fail(what+", but "+stale, f.staleFix())
		}
		if why := cfg.why(); pending != "" && why != "" {
			return warn(what+", but "+pending+": "+why, f.fix())
		}
		if cfg.Broken != "" {
			return warn(fmt.Sprintf("%s, but %s does not parse (%s): Docker does not start with it", what, cfg.File, cfg.Broken), f.fileFix())
		}
		if pending != "" {
			what += "; " + pending
		}
		return pass("%s", what)
	}
	if f.Probe.Refused != "" {
		detail := "Docker does not start containers on its default bridge: " + f.Probe.Refused
		if c := cfg.cause(); c != "" {
			detail += "; " + c
		}
		return fail(detail+"; "+dnsEffect, f.fix())
	}

	// No container ran: the setting alone says it.
	notes := slices.Clone(cfg.Unread)
	if f.Probe.Skipped != "" {
		notes = append(notes, f.Probe.Skipped)
	}
	if len(cfg.Sources) == 0 {
		switch {
		case !cfg.FileRead && cfg.ArgsFrom == "":
			return warn("could not tell which DNS servers Docker gives containers: "+strings.Join(notes, "; "),
				"Run the check as root on the node (`"+brand.Slug+" health`), or look yourself: `docker run --rm <an image you have> cat /etc/resolv.conf` must show nameserver lines with IP addresses.")
		case cfg.Broken != "":
			return warn(fmt.Sprintf("%s does not parse (%s): Docker does not start with it", cfg.File, cfg.Broken), f.fileFix())
		}
		detail := "no \"dns\" setting"
		var looked []string
		if cfg.FileRead {
			looked = append(looked, "in "+cfg.File)
		}
		if cfg.ArgsFrom != "" {
			looked = append(looked, "on "+cfg.ArgsFrom)
		}
		detail += " " + strings.Join(looked, " or ") + ", so containers get the host's servers"
		if len(notes) > 0 {
			detail += " (" + strings.Join(notes, "; ") + ")"
		}
		return pass("%s", detail)
	}
	suffix := ""
	if len(notes) > 0 {
		suffix = " (" + strings.Join(notes, "; ") + ")"
	}
	switch judgeServers(cfg.servers(), cfg.IPv6) {
	case dnsNone:
		return fail("containers get no DNS server they can use: "+cfg.cause()+"; "+dnsEffect+suffix, f.fix())
	case dnsIPv6Only:
		return warn(cfg.cause()+`: only IPv6 servers, and Docker's bridge has no IPv6 ("ipv6": true), so containers on it may not reach them`+suffix, f.fix())
	case dnsSome:
		return warn(cfg.cause()+"; containers use the servers that work, but the others should be fixed or removed"+suffix, f.fix())
	}
	given := "Docker gives containers " + serversText(cfg.servers()) + " (" + cfg.place() + ")"
	if stale := f.staleText(); stale != "" {
		if f.staleReloadLost() {
			// Without a test container, whether Docker holds the setting
			// now is not known.
			return fail(given+", but "+stale+"; "+f.staleReloadText()+"; no test container ran, so whether new containers get \"invalid IP\" too is not known"+suffix,
				f.staleFix()+" If Docker was reloaded since it last started, restart it, do not reload it: `systemctl restart docker` "+cfg.rereads()+". "+
					f.restartText()+reloadSafe())
		}
		return fail(given+", but "+stale, f.staleFix())
	}
	return pass("%s%s", given, suffix)
}

// fix is the hint for a "dns" setting that gives containers no usable
// server: the setting (or that it is fine already, when Docker runs with
// another), Docker's restart and what it stops, the containers that keep
// the old servers.
func (f dnsFindings) fix() string {
	cfg := f.Config
	var b strings.Builder
	flags, file := cfg.kinds()
	switch {
	case len(cfg.Sources) > 0 && judgeServers(cfg.servers(), cfg.IPv6) == dnsOK:
		// The setting read now is fine: Docker runs with another one.
		fmt.Fprintf(&b, "%s already gives %s. ", cfg.place(), serversText(cfg.servers()))
	default:
		if flags {
			b.WriteString("Remove the --dns flags from dockerd's command line or give them IP addresses (`systemctl cat docker` shows where they are set, `systemctl edit docker` overrides ExecStart), then run `systemctl daemon-reload`. ")
		}
		if file || !flags {
			fmt.Fprintf(&b, `Put IP addresses in %s ("dns": ["1.1.1.1", "8.8.4.4"]) or remove its "dns" key so containers get the host's servers, and check the file with `+"`dockerd --validate --config-file %s`. ", cfg.File, cfg.File)
		}
	}
	b.WriteString("Docker reads its settings only when it starts: restart it with `systemctl restart docker`. ")
	b.WriteString(f.restartText())
	workers := f.workers(false)
	if len(workers) == 0 {
		b.WriteString("The next build starts its build worker with the new servers.")
		return b.String()
	}
	b.WriteString(plural(len(workers), "A build worker that still runs afterwards keeps the old servers: ", "Build workers that still run afterwards keep the old servers: "))
	b.WriteString(f.workerCommands(workers))
	b.WriteString(f.healsText())
	return b.String()
}

// healsText says, in the agent's run, that the agent restarts a stale
// build worker itself (the check and the build service, restartStaleWorkers
// and build.WorkerDNS), "" elsewhere.
func (f dnsFindings) healsText() string {
	if !f.Heals {
		return ""
	}
	return " The agent restarts a build worker like this by itself once Docker gives new containers servers they can use and no build runs on it: before the next build there, and at the next check."
}

// restartText says what `systemctl restart docker` stops, from Docker's
// live-restore, how to keep containers running through it, and that a
// container which does keeps its old servers.
func (f dnsFindings) restartText() string {
	games, gamesToo := "", ""
	if f.Wings {
		games = ", Wings' game servers included"
		gamesToo = ", a Wings game server from Wings' panel"
	}
	// Docker restores a container that runs through its restart as it was,
	// DNS servers included (its resolv.conf, and the embedded DNS's list for
	// one on a project network): only a container's own restart gives it
	// the new ones.
	kept := "A container that keeps running through the restart keeps its old servers until it is restarted itself (an app with Restart on its page in the panel" + gamesToo + "); this check names ours that still have them. "
	switch {
	case f.LiveRestore == nil:
		return `A Docker restart stops every container on this server` + games + `, unless "live-restore": true is set. ` + kept
	case *f.LiveRestore:
		return "Live-restore is on, so containers keep running through the restart. " + kept
	}
	s := "Live-restore is off, so the restart stops every container on this server" + games +
		`: to keep them running, first add "live-restore": true to ` + f.Config.File + " and run `systemctl reload docker` (restarts nothing)"
	if f.reloadRisk() {
		// The restart reads the setting again; containers created between
		// the two get "invalid IP".
		s += fmt.Sprintf(", then `systemctl restart docker` right after it: on Docker %s a reload also empties the \"dns\" setting, so containers created after it get \"nameserver invalid IP\" until Docker restarts (moby#52060)", f.Version)
	}
	return s + ". " + kept
}

// reloadFix is the hint when a reload emptied Docker's "dns" setting
// (moby#52060): restart Docker, not reload it, what the restart stops,
// our containers created since that keep "invalid IP", and the release
// that fixes it. The setting itself is fine.
func (f dnsFindings) reloadFix() string {
	var b strings.Builder
	fmt.Fprintf(&b, "Restart Docker, do not reload it: `systemctl restart docker` %s, while a reload on Docker %s empties the \"dns\" setting again. ", f.Config.rereads(), f.Version)
	b.WriteString(f.restartText())
	if stale := f.staleFix(); stale != "" {
		b.WriteString(stale + " ")
	}
	b.WriteString(reloadSafe())
	return b.String()
}

// fileFix is the hint for a daemon.json that does not parse.
func (f dnsFindings) fileFix() string {
	return fmt.Sprintf("Fix %s and check it with `dockerd --validate --config-file %s`: Docker reads it only when it starts, and a broken file keeps it from starting.", f.Config.File, f.Config.File)
}

// staleFix is the hint for containers of ours that kept the old servers.
func (f dnsFindings) staleFix() string {
	var parts []string
	if stale := f.workers(true); len(stale) > 0 {
		parts = append(parts, "A build worker keeps the DNS servers it started with: "+f.workerCommands(stale)+f.healsText())
	}
	if stale := f.staleApps(); len(stale) > 0 {
		var services, others []string
		for _, c := range stale {
			if c.Service {
				services = append(services, c.Name)
			} else {
				others = append(others, c.Name)
			}
		}
		var how []string
		if len(services) > 0 {
			how = append(how, "Restart on the app's page in the panel for "+strings.Join(services, ", ")+" (it restarts the app's containers in place, no deploy)")
		}
		if len(others) > 0 {
			how = append(how, "`docker restart "+strings.Join(others, " ")+"`")
		}
		parts = append(parts, "A container keeps the DNS servers it started with, also through a Docker restart with live-restore on: restart "+
			plural(len(stale), "it", "them")+" with "+strings.Join(how, ", and ")+".")
	}
	return strings.Join(parts, " ")
}

func (f dnsFindings) workerCommands(workers []ownContainer) string {
	containers := make([]string, len(workers))
	builders := make([]string, len(workers))
	for i, w := range workers {
		containers[i], builders[i] = w.Name, w.Builder
	}
	return fmt.Sprintf("restart %s (`docker restart %s`, which keeps the build cache) or remove %s (`DOCKER_CONFIG=%s docker buildx rm %s`; the next build makes a new one).",
		plural(len(workers), "it", "them"), strings.Join(containers, " "), plural(len(workers), "it", "them"), f.BuildsConfig, strings.Join(builders, " "))
}
