package nodecheck

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/netip"
	"os"
	"path/filepath"
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
// container. Docker does not check the entries well: Docker 29 starts
// with an empty "" entry (dockerd --validate accepts it too) and writes
// "nameserver invalid IP" for it (seen on Docker 29.5 in the test VM, as
// on the real node); Docker 28 refuses to start the container ("bad
// nameserver address <nil>"). A container on the default bridge, where
// the build worker runs, then has no server, and BuildKit (Go) falls back
// to [::1]:53:
// "lookup registry-1.docker.io on [::1]:53: ... connection refused". Apps
// on their project networks ask Docker's embedded DNS, which forwards to
// the same servers, so their outside lookups fail too.
//
// What the check reads, most reliable first:
//
//   - a test container on the default bridge (`docker run --rm --pull
//     never --network bridge --entrypoint cat <image> /etc/resolv.conf`):
//     what Docker gives a new container now, where new build workers run.
//     Only an image already on the node is used (probeRepos); none is
//     pulled, like every other check. It runs with every health check
//     (hourly, and Run checks now) and is gone in well under a second.
//   - the running build workers' resolv.conf, read from the file Docker
//     mounts into them (<DockerRootDir>/containers/<id>/resolv.conf):
//     they keep the servers they started with, also after a fix.
//   - to say where the servers come from: the running dockerd's command
//     line (/proc, else docker.service's ExecStart) for --dns and
//     --config-file, and daemon.json at that path (an edit there applies
//     at Docker's next restart). GET /info has no DNS field.
//
// It never changes daemon.json or restarts Docker: a restart stops every
// container on the server unless live-restore is on, Wings' game servers
// too, so the fix hint says how and leaves it to the person.

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

// dockerdArgs is the running dockerd's command line (/proc/<pid>/cmdline),
// or docker.service's ExecStart when no dockerd process is visible (/proc
// with hidepid, for a run without root). from says which; "" when neither
// could be read.
func (e *Env) dockerdArgs(ctx context.Context) (args []string, from string) {
	entries, _ := os.ReadDir(e.ProcDir)
	for _, entry := range entries {
		pid := entry.Name()
		if _, err := strconv.Atoi(pid); err != nil {
			continue
		}
		if comm, err := e.read(filepath.Join(e.ProcDir, pid, "comm")); err != nil || strings.TrimSpace(comm) != "dockerd" {
			continue
		}
		cmdline, err := e.read(filepath.Join(e.ProcDir, pid, "cmdline"))
		if err != nil || strings.Trim(cmdline, "\x00") == "" {
			continue
		}
		return strings.Split(strings.TrimRight(cmdline, "\x00"), "\x00"), "dockerd's command line (pid " + pid + ")"
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

func (e *Env) probeDNS(ctx context.Context) dnsProbe {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
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
	// Like every container we create, out of a Docker-provider Traefik's
	// sight (Wings').
	out, err := e.dockerCLI(ctx, "run", "--rm", "--pull", "never", "--network", "bridge", "--label", docker.LabelTraefikEnable+"=false",
		"--entrypoint", "cat", image, "/etc/resolv.conf")
	if err != nil {
		msg := commandMessage(err)
		if strings.Contains(msg, "nameserver") {
			return dnsProbe{Image: image, Refused: msg}
		}
		return dnsProbe{Image: image, Skipped: "the test container from " + image + " did not run: " + msg}
	}
	rc := parseResolvConf(out)
	return dnsProbe{Image: image, RC: &rc}
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

// buildWorker is a running build worker container and its resolv.conf.
type buildWorker struct {
	Container, Builder string
	RC                 resolvConf
}

// buildWorkers reads the running build workers' resolv.conf from the file
// Docker mounts into each (under info's DockerRootDir), so nothing runs in
// them.
func (e *Env) buildWorkers(ctx context.Context, info *DockerInfo) []buildWorker {
	if info == nil || info.DockerRootDir == "" {
		return nil
	}
	prefix := buildWorkerPrefix()
	list, err := e.Docker.Containers(ctx, map[string][]string{"name": {prefix}, "status": {"running"}})
	if err != nil {
		return nil
	}
	var out []buildWorker
	for _, c := range list {
		name := c.Name()
		if c.State != "running" || !strings.HasPrefix(name, prefix) || c.ID == "" || strings.ContainsAny(c.ID, `/\.`) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(info.DockerRootDir, "containers", c.ID, "resolv.conf"))
		if err != nil {
			continue
		}
		// Builder <name> runs in container buildx_buildkit_<name>0.
		builder := strings.TrimRight(strings.TrimPrefix(name, "buildx_buildkit_"), "0123456789")
		out = append(out, buildWorker{Container: name, Builder: builder, RC: parseResolvConf(string(data))})
	}
	slices.SortFunc(out, func(a, b buildWorker) int { return strings.Compare(a.Container, b.Container) })
	return out
}

// dnsFindings is everything the check read.
type dnsFindings struct {
	Config  daemonDNS
	Probe   dnsProbe
	Workers []buildWorker
	// LiveRestore is Docker's live-restore, nil when Docker is not
	// reachable.
	LiveRestore *bool
	Wings       bool
	// BuildsConfig is the builds' DOCKER_CONFIG, where the builders are.
	BuildsConfig string
}

func (e *Env) containerDNS(ctx context.Context) *agentv1.NodeCheckResult {
	info, err := e.Docker.Info(ctx)
	if err != nil {
		info = nil
	}
	f := dnsFindings{
		Config:       e.daemonDNS(ctx),
		Probe:        e.probeDNS(ctx),
		Workers:      e.buildWorkers(ctx, info),
		Wings:        e.wingsInfo(ctx) != nil,
		BuildsConfig: e.layout().BuildsDockerConfig(),
	}
	if info != nil {
		f.LiveRestore = &info.LiveRestoreEnabled
	}
	return f.result()
}

const dnsEffect = "builds cannot pull images (the build worker runs on Docker's default bridge) and apps cannot look up names outside this server"

// staleText says which build workers kept servers they cannot use.
func staleText(stale []string) string {
	n := len(stale)
	return fmt.Sprintf("%s %s still %s no DNS server %s can use, from before, so builds there cannot pull images",
		plural(n, "the build worker", "the build workers"), strings.Join(stale, ", "), plural(n, "has", "have"), plural(n, "it", "they"))
}

func (f dnsFindings) result() *agentv1.NodeCheckResult {
	cfg := f.Config
	if rc := f.Probe.RC; rc != nil {
		what := fmt.Sprintf("a test container on Docker's default bridge (%s) gets %s", f.Probe.Image, serversText(rc.Servers))
		// The setting as read now is what containers get, or it changed
		// after Docker started and applies at its next restart.
		current := rc.Override && len(cfg.Sources) > 0 && sameServers(rc.Servers, cfg.servers())
		switch {
		case current:
			what += ", from " + cfg.cause()
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
		if stale := f.staleWorkers(); len(stale) > 0 {
			return fail(what+", but "+staleText(stale), f.workerFix())
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
	if stale := f.staleWorkers(); len(stale) > 0 {
		return fail(given+", but "+staleText(stale), f.workerFix())
	}
	return pass("%s%s", given, suffix)
}

// staleWorkers are the running build workers without a usable server.
func (f dnsFindings) staleWorkers() []string {
	var out []string
	for _, w := range f.Workers {
		if judgeServers(w.RC.Servers, true) == dnsNone {
			out = append(out, w.Container)
		}
	}
	return out
}

// fix is the hint for a "dns" setting that gives containers no usable
// server: the setting, Docker's restart and what it stops, the build
// workers.
func (f dnsFindings) fix() string {
	cfg := f.Config
	var b strings.Builder
	flags := slices.ContainsFunc(cfg.Sources, func(s dnsSource) bool { return s.Flags })
	file := slices.ContainsFunc(cfg.Sources, func(s dnsSource) bool { return !s.Flags })
	if flags {
		b.WriteString("Remove the --dns flags from dockerd's command line or give them IP addresses (`systemctl cat docker` shows where they are set, `systemctl edit docker` overrides ExecStart), then run `systemctl daemon-reload`. ")
	}
	if file || !flags {
		fmt.Fprintf(&b, `Put IP addresses in %s ("dns": ["1.1.1.1", "8.8.4.4"]) or remove its "dns" key so containers get the host's servers, and check the file with `+"`dockerd --validate --config-file %s`. ", cfg.File, cfg.File)
	}
	b.WriteString("Docker reads its settings only when it starts: restart it with `systemctl restart docker`. ")
	games := ""
	if f.Wings {
		games = ", Wings' game servers included"
	}
	switch {
	case f.LiveRestore == nil:
		b.WriteString(`A Docker restart stops every container on this server` + games + `, unless "live-restore": true is set. `)
	case *f.LiveRestore:
		b.WriteString("Live-restore is on, so containers keep running through the restart. ")
	default:
		b.WriteString("Live-restore is off, so the restart stops every container on this server" + games)
		fmt.Fprintf(&b, `: to keep them running, first add "live-restore": true to %s and run `+"`systemctl reload docker`"+` (restarts nothing). `, cfg.File)
	}
	if len(f.Workers) == 0 {
		b.WriteString("The next build starts its build worker with the new servers.")
		return b.String()
	}
	b.WriteString(plural(len(f.Workers), "A build worker that still runs afterwards keeps the old servers: ", "Build workers that still run afterwards keep the old servers: "))
	b.WriteString(f.workerCommands(f.Workers))
	return b.String()
}

// fileFix is the hint for a daemon.json that does not parse.
func (f dnsFindings) fileFix() string {
	return fmt.Sprintf("Fix %s and check it with `dockerd --validate --config-file %s`: Docker reads it only when it starts, and a broken file keeps it from starting.", f.Config.File, f.Config.File)
}

// workerFix is the hint for build workers that kept the old servers.
func (f dnsFindings) workerFix() string {
	var stale []buildWorker
	for _, w := range f.Workers {
		if judgeServers(w.RC.Servers, true) == dnsNone {
			stale = append(stale, w)
		}
	}
	return "A build worker keeps the DNS servers it started with: " + f.workerCommands(stale)
}

func (f dnsFindings) workerCommands(workers []buildWorker) string {
	containers := make([]string, len(workers))
	builders := make([]string, len(workers))
	for i, w := range workers {
		containers[i], builders[i] = w.Container, w.Builder
	}
	return fmt.Sprintf("restart %s (`docker restart %s`, which keeps the build cache) or remove %s (`DOCKER_CONFIG=%s docker buildx rm %s`; the next build makes a new one).",
		plural(len(workers), "it", "them"), strings.Join(containers, " "), plural(len(workers), "it", "them"), f.BuildsConfig, strings.Join(builders, " "))
}
