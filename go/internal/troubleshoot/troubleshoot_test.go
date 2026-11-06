package troubleshoot

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/nodecheck"
)

// siteRules is a Go port of the site API's refusal rules (in the private
// Website repo). A redacted report must pass them, or uploads would be
// refused.
var siteRules = []struct {
	name       string
	re         *regexp.Regexp
	valueGroup int
}{
	{"private-key", regexp.MustCompile(`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----`), 0},
	{"aws-access-key", regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`), 0},
	{"github-token", regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b`), 0},
	{"slack-token", regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{10,}`), 0},
	{"stripe-key", regexp.MustCompile(`\b[rs]k_live_[A-Za-z0-9]{20,}`), 0},
	{"anthropic-key", regexp.MustCompile(`\bsk-ant-[A-Za-z0-9_-]{20,}`), 0},
	{"openai-key", regexp.MustCompile(`\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}`), 0},
	{"cloudflare-token", regexp.MustCompile(`(?i)\b(?:CF|CLOUDFLARE)_[A-Z_]*TOKEN\s*[=:]\s*["']?([A-Za-z0-9_-]{30,})`), 1},
	{"jwt", regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`), 0},
	{"url-password", regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.-]*://[^\s:@/]+:([^\s@/]+)@`), 1},
	{"secret-assignment", regexp.MustCompile(`(?i)\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\b["']?\s*[:=]\s*["']?([^\s"',]+)`), 1},
}

var siteMarker = regexp.MustCompile(`(?i)^(\[redacted\]|<redacted>|\*{3,}|x{3,}|""|''|)$`)

func siteFindings(md string) []string {
	var out []string
	for i, line := range strings.Split(md, "\n") {
		for _, r := range siteRules {
			m := r.re.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			if r.valueGroup > 0 {
				v := m[r.valueGroup]
				if siteMarker.MatchString(v) || r.name == "secret-assignment" && len(v) < 8 {
					continue
				}
			}
			out = append(out, fmt.Sprintf("%s@%d: %s", r.name, i+1, line))
		}
	}
	return out
}

const leaky = `panel_url: https://admin:hunter2hunter2@panel.example.com
join_token: seylo_join_abcdefghijklmnop
api key in a log: Authorization: Bearer seylo_key_0123456789abcdef
DB_PASSWORD=correct-horse-battery
CLOUDFLARE_API_TOKEN="abcdefghijklmnopqrstuvwxyz0123456789"
password: "s3cr3t-passw0rd"
aws AKIAABCDEFGHIJKLMNOP
gh token ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ
anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz
jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop
setup link http://203.0.113.7:3000/setup?t=Zm9vYmFyYmF6cXV4&x=1
owner is someone@example.com
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
-----END OPENSSH PRIVATE KEY-----
peer 10.0.0.5 and public 203.0.113.7 and docker 172.17.0.2
`

func TestRedactPassesTheSiteCheck(t *testing.T) {
	if len(siteFindings(leaky)) == 0 {
		t.Fatal("the fixture should trip the site check before redaction")
	}
	out := Redact(leaky, RedactOptions{Emails: true, IPs: true})
	if f := siteFindings(out); len(f) > 0 {
		t.Fatalf("site would refuse:\n%s\n\nredacted:\n%s", strings.Join(f, "\n"), out)
	}
	for _, secret := range []string{"hunter2", "seylo_join_", "seylo_key_", "correct-horse", "abcdefghijklmnopqrstuvwxyz0123456789", "s3cr3t", "AKIA", "ghp_", "sk-ant", "eyJ", "Zm9vYmFy", "someone@example.com", "b3BlbnNzaC1", "203.0.113.7"} {
		if strings.Contains(out, secret) {
			t.Errorf("%q survived redaction:\n%s", secret, out)
		}
	}
	for _, keep := range []string{"panel.example.com", "10.0.0.5", "172.17.0.2", "&x=1", "panel_url: https://admin:"} {
		if !strings.Contains(out, keep) {
			t.Errorf("%q was removed but carries no secret:\n%s", keep, out)
		}
	}
}

func TestRedactIsIdempotentAndOptional(t *testing.T) {
	once := Redact(leaky, RedactOptions{Emails: true})
	if twice := Redact(once, RedactOptions{Emails: true}); twice != once {
		t.Fatalf("second pass changed the text:\n%s", twice)
	}
	if !strings.Contains(once, "203.0.113.7") {
		t.Fatal("IPs are kept unless asked")
	}
	if !strings.Contains(Redact("mail me at a@b.co", RedactOptions{}), "a@b.co") {
		t.Fatal("emails kept when Emails is off")
	}
	plain := "level=info msg=\"deploy finished\" service_id=abc generation=4 password_set=true"
	if got := Redact(plain, RedactOptions{}); !strings.Contains(got, "deploy finished") || !strings.Contains(got, "generation=4") {
		t.Fatalf("plain log line damaged: %q", got)
	}
}

type fakeDocker struct{}

func (fakeDocker) Info(context.Context) (*nodecheck.DockerInfo, error) {
	return &nodecheck.DockerInfo{ServerVersion: "28.0.1", Driver: "overlay2", CgroupVersion: "2", CgroupDriver: "systemd"}, nil
}

func (fakeDocker) Containers(_ context.Context, f map[string][]string) ([]nodecheck.DockerContainer, error) {
	return []nodecheck.DockerContainer{{ID: "c1", Names: []string{"/seylo-web-3"}, Image: "nginx:1.27", State: "running", Status: "Up 2 hours"}}, nil
}

type okCheck struct{}

func (okCheck) ID() string    { return "disk.space" }
func (okCheck) Title() string { return "Disk space" }
func (okCheck) Run(context.Context) *agentv1.NodeCheckResult {
	return &agentv1.NodeCheckResult{Status: agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN, Detail: "9 GiB | free", FixHint: "clean up"}
}

func fakeOptions(t *testing.T) Options {
	return Options{
		DataDir:            t.TempDir(),
		IncludeServiceLogs: true,
		Docker:             fakeDocker{},
		Checks:             []nodecheck.Check{okCheck{}},
		Now:                func() time.Time { return time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC) },
		ReadFile: func(path string) ([]byte, error) {
			switch {
			case strings.HasSuffix(path, "config.yml"):
				return []byte("panel_url: https://panel.example.com\nnode_id: n1\njoin_token: seylo_join_secretsecret\n"), nil
			case path == "/etc/os-release":
				return []byte("PRETTY_NAME=\"Ubuntu 24.04 LTS\"\n"), nil
			}
			return nil, errors.New("no such file")
		},
		Run: func(_ context.Context, w io.Writer, name string, args ...string) error {
			switch name {
			case "journalctl":
				_, _ = io.WriteString(w, "2026-11-05T11:59:00Z node seylo[1]: dial failed token=abcdefghijkl1234 owner admin@example.com\n")
			case "docker":
				_, _ = io.WriteString(w, "2026-11-05T11:59:00Z GET / 200\n```\n")
			case "systemctl":
				_, _ = io.WriteString(w, "ActiveState=active\nSubState=running\n")
			}
			return nil
		},
	}
}

func TestBuild(t *testing.T) {
	md := Build(context.Background(), fakeOptions(t))
	for _, want := range []string{
		"# Seylo troubleshoot report", "## Versions", "| Docker | 28.0.1 |", "| OS | Ubuntu 24.04 LTS |",
		"| disk.space | warn | 9 GiB / free | clean up |", "ActiveState=active", "seylo-web-3", "## Agent configuration",
		"node_id: n1", "## Service logs (last lines)", "### seylo-web-3",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("report misses %q", want)
		}
	}
	for _, secret := range []string{"seylo_join_secretsecret", "abcdefghijkl1234", "admin@example.com"} {
		if strings.Contains(md, secret) {
			t.Errorf("report leaks %q", secret)
		}
	}
	if strings.Count(md, "```")%2 != 0 {
		t.Error("unbalanced code fences")
	}
	if f := siteFindings(md); len(f) > 0 {
		t.Errorf("site would refuse: %v", f)
	}
}

func TestTruncate(t *testing.T) {
	long := "# r\n\n```\n" + strings.Repeat("line of log\n", 100000)
	out := truncate(long, MaxReportBytes)
	if len(out) > MaxReportBytes || !strings.HasSuffix(out, "_Report truncated to fit the upload limit._\n") || strings.Count(out, "```")%2 != 0 {
		t.Fatalf("truncate: len %d, tail %q", len(out), out[len(out)-80:])
	}
	if truncate("short", 100) != "short" {
		t.Fatal("short report changed")
	}
}

func TestUpload(t *testing.T) {
	var got string
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got = string(body)
		switch {
		case r.Method != http.MethodPost || r.URL.Path != "/l":
			http.NotFound(w, r)
		case strings.Contains(got, "leak"):
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = io.WriteString(w, `{"error":"unredacted_secrets","findings":[{"rule":"jwt","line":3}]}`)
		default:
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, `{"id":"abc","url":"https://seylo.dev/l/abc","expiresAt":"2026-12-05T00:00:00Z","deleteToken":"d"}`)
		}
	}))
	defer site.Close()

	opts := fakeOptions(t)
	opts.Upload, opts.SiteURL = true, site.URL+"/"
	res, err := Run(context.Background(), opts)
	if err != nil || res.URL != "https://seylo.dev/l/abc" || res.DeleteToken != "d" || got != res.Markdown {
		t.Fatalf("Run = %+v, %v", res, err)
	}

	_, err = Upload(context.Background(), http.DefaultClient, site.URL, "a leak")
	var refused *RefusedError
	if !errors.As(err, &refused) || refused.Findings[0].Rule != "jwt" || !strings.Contains(err.Error(), "jwt on line 3") {
		t.Fatalf("err = %v", err)
	}
}

// TestUploadToSite uploads a redacted report to a running site API (from
// the private Website repo). Set SEYLO_TEST_SITE_URL to run it.
func TestUploadToSite(t *testing.T) {
	site := os.Getenv("SEYLO_TEST_SITE_URL")
	if site == "" {
		t.Skip("SEYLO_TEST_SITE_URL not set")
	}
	opts := fakeOptions(t)
	opts.SiteURL = site
	md := Build(context.Background(), opts) + "\n## Leaky fixture, redacted\n\n" + Redact(leaky, RedactOptions{Emails: true})
	up, err := Upload(context.Background(), http.DefaultClient, site, md)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("uploaded: %s (expires %s)", up.URL, up.ExpiresAt)
	if _, err := Upload(context.Background(), http.DefaultClient, site, leaky); err == nil {
		t.Fatal("the site accepted an unredacted report")
	} else {
		t.Logf("unredacted report refused: %v", err)
	}
}

// TestBuildStripsExactSecretValues: a value with no recognizable shape
// (a secret env value, a database password) printed by an app in its logs
// is removed by value, read from the node's persisted desired state.
func TestBuildStripsExactSecretValues(t *testing.T) {
	desired, err := proto.Marshal(&agentv1.DesiredState{Services: []*agentv1.ServiceSpec{
		{
			Id:  "web",
			Env: []*agentv1.EnvVar{{Name: "SESSION_KEY", Value: "plainlookingvalue42", Secret: true}, {Name: "MODE", Value: "productionish"}},
		},
		{
			Id:       "db",
			KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Credentials: &agentv1.DatabaseCredentials{AdminPassword: "Tr0ub4dorAndThree"}}},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	opts := fakeOptions(t)
	read := opts.ReadFile
	opts.ReadFile = func(path string) ([]byte, error) {
		if strings.HasSuffix(path, "/state/desired.pb") {
			return desired, nil
		}
		return read(path)
	}
	run := opts.Run
	opts.Run = func(ctx context.Context, w io.Writer, name string, args ...string) error {
		if name == "docker" {
			_, _ = io.WriteString(w, "starting with plainlookingvalue42 in productionish mode\nauth ok for Tr0ub4dorAndThree\n")
			return nil
		}
		return run(ctx, w, name, args...)
	}
	md := Build(context.Background(), opts)
	for _, secret := range []string{"plainlookingvalue42", "Tr0ub4dorAndThree"} {
		if strings.Contains(md, secret) {
			t.Errorf("report leaks %q", secret)
		}
	}
	if !strings.Contains(md, "starting with "+Marker+" in productionish mode") {
		t.Errorf("non-secret env value or the marker missing:\n%s", md)
	}
	if got := SectionTitles(opts); got[len(got)-1] != "Service logs (last lines)" {
		t.Errorf("SectionTitles = %v", got)
	}
	opts.IncludeServiceLogs = false
	if got := SectionTitles(opts); slices.Contains(got, "Service logs (last lines)") {
		t.Errorf("SectionTitles without service logs = %v", got)
	}
}
