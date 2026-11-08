package troubleshoot

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/crash"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/nodecheck"
	"github.com/seylo-dev/app/go/internal/systemd"
	"github.com/seylo-dev/app/go/internal/version"
	"github.com/seylo-dev/app/go/internal/wings"
)

// MaxReportBytes keeps reports under the site's 512 KiB upload limit.
const MaxReportBytes = 500 * 1024

// Options controls a troubleshoot run.
type Options struct {
	IncludeServiceLogs bool
	// Upload sends the report to the site and returns its link.
	Upload bool
	// RedactIPs also replaces public IP addresses.
	RedactIPs bool
	// KeepEmails leaves email addresses in (they are redacted by default).
	KeepEmails bool
	// SiteURL receives uploads at <SiteURL>/l. Default: <SLUG>_SITE_URL
	// from the environment, else brand.SiteURL.
	SiteURL string
	// DataDir is the node data dir. Default brand.DataDir.
	DataDir string
	// PanelURL lets the panel check run; empty skips it.
	PanelURL string
	// PanelPin is config.yml's panel_pin for that check.
	PanelPin string
	// LogLines of agent journal to include. Default 200.
	LogLines int

	// Collaborators; tests replace them.
	Run    systemd.Runner
	Docker nodecheck.DockerAPI
	// Checks overrides the node health checks.
	Checks []nodecheck.Check
	// ReadFile reads /etc and /proc files; default os.ReadFile.
	ReadFile func(path string) ([]byte, error)
	HTTP     *http.Client
	Now      func() time.Time
}

// Result is a finished report.
type Result struct {
	// Markdown is the redacted report.
	Markdown string
	// Sections are the titles of the report's sections, in order.
	Sections []string
	// URL, ExpiresAt and DeleteToken are set when the report was uploaded.
	URL         string
	ExpiresAt   string
	DeleteToken string
}

func (o *Options) defaults() {
	if o.SiteURL == "" {
		o.SiteURL = os.Getenv(strings.ToUpper(brand.Slug) + "_SITE_URL")
	}
	if o.SiteURL == "" {
		o.SiteURL = brand.SiteURL
	}
	if o.DataDir == "" {
		o.DataDir = brand.DataDir
	}
	if o.LogLines <= 0 {
		o.LogLines = 200
	}
	if o.Run == nil {
		o.Run = systemd.ExecRunner
	}
	if o.Docker == nil {
		o.Docker = nodecheck.NewDockerSocket("")
	}
	if o.ReadFile == nil {
		o.ReadFile = os.ReadFile
	}
	if o.HTTP == nil {
		o.HTTP = &http.Client{Timeout: 30 * time.Second}
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Checks == nil {
		o.Checks = nodecheck.Default(nodecheck.Env{DataDir: o.DataDir, PanelURL: o.PanelURL, PanelPin: o.PanelPin, GOARCH: runtime.GOARCH, Docker: o.Docker, Run: o.Run,
			Wings: wings.NewDetector().Detect})
	}
}

// Run builds the redacted report and, with Upload, uploads it.
func Run(ctx context.Context, opts Options) (Result, error) {
	opts.defaults()
	md := Build(ctx, opts)
	res := Result{Markdown: md, Sections: SectionTitles(opts)}
	if !opts.Upload {
		return res, nil
	}
	up, err := Upload(ctx, opts.HTTP, opts.SiteURL, md)
	if err != nil {
		return res, err
	}
	res.URL, res.ExpiresAt, res.DeleteToken = up.URL, up.ExpiresAt, up.DeleteToken
	return res, nil
}

type section struct {
	title string
	fn    func(context.Context, *Options) string
}

func sections(opts Options) []section {
	list := []section{
		{"Versions", versions},
		{"Node health checks", healthChecks},
		{"Agent service", agentService},
		{"Docker", dockerSection},
		{brand.DisplayName + " containers", containers},
		{"Agent configuration", agentConfig},
		{"Recent errors", recentErrors},
		{"Agent log (last lines)", agentLog},
	}
	if opts.IncludeServiceLogs {
		list = append(list, section{"Service logs (last lines)", serviceLogs})
	}
	return list
}

// SectionTitles lists the sections a report built with opts contains, so
// the CLI can say what it shares (service logs carry app output).
func SectionTitles(opts Options) []string {
	var out []string
	for _, s := range sections(opts) {
		out = append(out, s.title)
	}
	return out
}

// Build collects every section and redacts the result. A section that
// cannot be collected says why instead of failing the report.
func Build(ctx context.Context, opts Options) string {
	opts.defaults()
	var b strings.Builder
	fmt.Fprintf(&b, "# %s troubleshoot report\n\n", brand.DisplayName)
	fmt.Fprintf(&b, "Generated %s by `%s troubleshoot`. Secrets, tokens and email addresses are replaced with %s.\n\n",
		opts.Now().UTC().Format(time.RFC3339), brand.Slug, Marker)

	for _, s := range sections(opts) {
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		body := s.fn(cctx, &opts)
		cancel()
		fmt.Fprintf(&b, "## %s\n\n%s\n\n", s.title, strings.TrimRight(body, "\n"))
	}
	// Exact values first: an app that prints its database password or a
	// secret env value in its logs is caught even when the value has no
	// recognizable shape. Then the shape-based pass.
	report := redactValues(b.String(), secretValues(&opts))
	report = Redact(report, RedactOptions{Emails: !opts.KeepEmails, IPs: opts.RedactIPs})
	return truncate(report, MaxReportBytes)
}

// secretValues lists every secret the node's persisted desired state
// carries (secret env values, database passwords, registry passwords,
// tunnel tokens), the same list crash reports and cron output strip. The
// file is only read here, never moved or rewritten. An unreadable state
// gives no values; the shape-based pass still runs.
func secretValues(o *Options) []string {
	data, err := o.ReadFile(filepath.Join(o.DataDir, "state", "desired.pb"))
	if err != nil {
		return nil
	}
	desired := &agentv1.DesiredState{}
	if err := proto.Unmarshal(data, desired); err != nil {
		return nil
	}
	var out []string
	for _, spec := range desired.GetServices() {
		out = append(out, crash.SecretValues(spec)...)
	}
	return out
}

// redactValues replaces every occurrence of a secret value with Marker.
// Longer values go first so a value that contains another is replaced
// whole; values under 4 characters are skipped like crash.Redact does.
func redactValues(text string, values []string) string {
	vals := slices.DeleteFunc(slices.Clone(values), func(v string) bool { return len(v) < 4 })
	slices.SortFunc(vals, func(a, b string) int { return len(b) - len(a) })
	for _, v := range slices.Compact(vals) {
		text = strings.ReplaceAll(text, v, Marker)
	}
	return text
}

func (o *Options) output(ctx context.Context, name string, args ...string) (string, error) {
	var out bytes.Buffer
	err := o.Run(ctx, &out, name, args...)
	return out.String(), err
}

func fence(text string) string {
	text = strings.TrimRight(text, "\n")
	if text == "" {
		text = "(empty)"
	}
	// A log line holding ``` must not end the block early.
	text = strings.ReplaceAll(text, "```", "'''")
	return "```\n" + text + "\n```"
}

func unavailable(what string, err error) string {
	return fmt.Sprintf("_%s unavailable: %s_", what, strings.TrimSpace(err.Error()))
}

func versions(ctx context.Context, o *Options) string {
	rows := [][2]string{
		{"Agent", version.String()},
		{"Architecture", runtime.GOARCH},
	}
	if data, err := o.ReadFile("/etc/os-release"); err == nil {
		for line := range strings.SplitSeq(string(data), "\n") {
			if v, ok := strings.CutPrefix(line, "PRETTY_NAME="); ok {
				rows = append(rows, [2]string{"OS", strings.Trim(v, `"`)})
			}
		}
	}
	if data, err := o.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		rows = append(rows, [2]string{"Kernel", strings.TrimSpace(string(data))})
	}
	if info, err := o.Docker.Info(ctx); err == nil {
		rows = append(rows, [2]string{"Docker", info.ServerVersion})
	}
	if data, err := o.ReadFile("/proc/uptime"); err == nil {
		var secs float64
		if _, err := fmt.Sscanf(string(data), "%f", &secs); err == nil {
			rows = append(rows, [2]string{"Uptime", (time.Duration(secs) * time.Second).String()})
		}
	}
	var b strings.Builder
	b.WriteString("| | |\n|---|---|\n")
	for _, r := range rows {
		fmt.Fprintf(&b, "| %s | %s |\n", r[0], cell(r[1]))
	}
	return b.String()
}

func healthChecks(ctx context.Context, o *Options) string {
	results := nodecheck.Run(ctx, o.Checks)
	var b strings.Builder
	b.WriteString("| Check | Result | Detail | Fix |\n|---|---|---|---|\n")
	for _, r := range results {
		fmt.Fprintf(&b, "| %s | %s | %s | %s |\n", r.GetId(), statusWord(r.GetStatus()), cell(r.GetDetail()), cell(r.GetFixHint()))
	}
	return b.String()
}

func statusWord(s agentv1.NodeCheckStatus) string {
	switch s {
	case agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS:
		return "ok"
	case agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN:
		return "warn"
	case agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL:
		return "FAIL"
	case agentv1.NodeCheckStatus_NODE_CHECK_STATUS_SKIPPED:
		return "skipped"
	}
	return "?"
}

func cell(s string) string {
	return strings.NewReplacer("|", "/", "\n", " ").Replace(s)
}

func agentService(ctx context.Context, o *Options) string {
	out, err := o.output(ctx, "systemctl", "show", systemd.AgentUnit,
		"--property=ActiveState,SubState,NRestarts,ExecMainStartTimestamp,ExecMainStatus,MemoryCurrent")
	if err != nil {
		return unavailable("systemctl", err)
	}
	return fence(out)
}

func dockerSection(ctx context.Context, o *Options) string {
	info, err := o.Docker.Info(ctx)
	if err != nil {
		return unavailable("Docker", err)
	}
	lines := []string{
		"Version: " + info.ServerVersion,
		"Storage driver: " + info.Driver,
		"Cgroup: v" + info.CgroupVersion + " (" + info.CgroupDriver + ")",
		"Root dir: " + info.DockerRootDir,
		"OS: " + info.OperatingSystem + " (" + info.Architecture + ")",
		fmt.Sprintf("Containers: %d, images: %d", info.Containers, info.Images),
	}
	for _, w := range info.Warnings {
		lines = append(lines, "Warning: "+w)
	}
	return fence(strings.Join(lines, "\n"))
}

func managedFilter(states ...string) map[string][]string {
	f := map[string][]string{"label": {docker.LabelManaged + "=true"}}
	if len(states) > 0 {
		f["status"] = states
	}
	return f
}

func containers(ctx context.Context, o *Options) string {
	list, err := o.Docker.Containers(ctx, managedFilter())
	if err != nil {
		return unavailable("container list", err)
	}
	if len(list) == 0 {
		return "_No managed containers._"
	}
	var b strings.Builder
	b.WriteString("| Name | Image | State | Status |\n|---|---|---|---|\n")
	for _, c := range list {
		fmt.Fprintf(&b, "| %s | %s | %s | %s |\n", cell(c.Name()), cell(c.Image), cell(c.State), cell(c.Status))
	}
	return b.String()
}

func agentConfig(_ context.Context, o *Options) string {
	data, err := o.ReadFile(filepath.Join(o.DataDir, "config.yml"))
	if err != nil {
		return unavailable("config.yml", err)
	}
	return fence(string(data))
}

func recentErrors(ctx context.Context, o *Options) string {
	var parts []string
	for _, unit := range []string{systemd.AgentUnit, "docker.service"} {
		out, err := o.output(ctx, "journalctl", "--unit", unit, "--priority", "err", "--since", "-24h",
			"--lines", "50", "--no-pager", "--output", "short-iso")
		if err != nil {
			parts = append(parts, "### "+unit+"\n\n"+unavailable("journal", err))
			continue
		}
		parts = append(parts, "### "+unit+"\n\n"+fence(out))
	}
	return strings.Join(parts, "\n\n")
}

func agentLog(ctx context.Context, o *Options) string {
	out, err := o.output(ctx, "journalctl", "--unit", systemd.AgentUnit, "--lines", fmt.Sprint(o.LogLines),
		"--no-pager", "--output", "short-iso")
	if err != nil {
		return unavailable("journal", err)
	}
	return fence(out)
}

func serviceLogs(ctx context.Context, o *Options) string {
	list, err := o.Docker.Containers(ctx, managedFilter("running", "exited", "restarting"))
	if err != nil {
		return unavailable("container list", err)
	}
	var parts []string
	for _, c := range list {
		out, err := o.output(ctx, "docker", "logs", "--tail", "50", "--timestamps", c.ID)
		if err != nil {
			parts = append(parts, "### "+c.Name()+"\n\n"+unavailable("logs", err))
			continue
		}
		parts = append(parts, "### "+c.Name()+"\n\n"+fence(out))
	}
	if len(parts) == 0 {
		return "_No managed containers._"
	}
	return strings.Join(parts, "\n\n")
}

// truncate keeps the report under limit, cutting from the end and saying
// so.
func truncate(report string, limit int) string {
	if len(report) <= limit {
		return report
	}
	note := "\n\n_Report truncated to fit the upload limit._\n"
	cut := report[:limit-len(note)-4]
	if i := strings.LastIndexByte(cut, '\n'); i > 0 {
		cut = cut[:i]
	}
	// Close an open code block so the page renders.
	if strings.Count(cut, "```")%2 == 1 {
		cut += "\n```"
	}
	return cut + note
}
