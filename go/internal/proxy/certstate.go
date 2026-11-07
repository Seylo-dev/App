package proxy

import (
	"bufio"
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// CertFailures remembers the last ACME failure per host name, read from
// Traefik's log: Traefik does not write failures to acme.json, so the log
// is the only place they show up. A host's failure is reported until a
// certificate for it appears, failureTTL passes or someone retries it
// (Retried): then only failures logged after the retry count.
type CertFailures struct {
	mu    sync.Mutex
	hosts map[string]certFailure
	// retried is when each host's certificate was last retried; failure
	// lines from before that (read late, while the follower catches up on
	// the backlog) are old news.
	retried map[string]time.Time
	now     func() time.Time
}

type certFailure struct {
	message string
	at      time.Time
}

// failureTTL bounds how long a failure is shown without a new one: Traefik
// tries again when routes change or the agent restarts it.
const failureTTL = 24 * time.Hour

// NewCertFailures returns an empty tracker.
func NewCertFailures() *CertFailures {
	return &CertFailures{hosts: map[string]certFailure{}, retried: map[string]time.Time{}, now: time.Now}
}

// Failure returns the last ACME error for host, if any is still current.
func (f *CertFailures) Failure(host string) (string, bool) {
	if f == nil {
		return "", false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	e, ok := f.hosts[strings.ToLower(host)]
	if !ok || f.now().Sub(e.at) > failureTTL {
		return "", false
	}
	return e.message, true
}

// Forget drops a host's failure (its certificate arrived).
func (f *CertFailures) Forget(host string) {
	if f == nil {
		return
	}
	f.mu.Lock()
	delete(f.hosts, strings.ToLower(host))
	delete(f.retried, strings.ToLower(host))
	f.mu.Unlock()
}

// Retried drops the hosts' failures and ignores failure lines logged
// before at: Traefik was just asked to try again, so the host is pending
// until a certificate or a new failure appears.
func (f *CertFailures) Retried(hosts []string, at time.Time) {
	if f == nil {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.retried == nil {
		f.retried = map[string]time.Time{}
	}
	for h, t := range f.retried {
		if f.now().Sub(t) > failureTTL {
			delete(f.retried, h)
		}
	}
	for _, h := range hosts {
		h = strings.ToLower(h)
		delete(f.hosts, h)
		if prev, ok := f.retried[h]; !ok || at.After(prev) {
			f.retried[h] = at
		}
	}
}

// Observe reads one Traefik log line and records an ACME failure in it.
// It understands Traefik's default text format and its JSON format.
func (f *CertFailures) Observe(line string) bool {
	hosts, msg, at, ok := parseAcmeFailure(line)
	if !ok {
		return false
	}
	if at.IsZero() {
		at = f.now()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, h := range hosts {
		h = strings.ToLower(h)
		if prev, ok := f.hosts[h]; ok && prev.at.After(at) {
			continue
		}
		// Traefik's log has whole seconds: a failure in the second of the
		// retry counts as new, one from an earlier second does not.
		if retried, ok := f.retried[h]; ok && at.Before(retried.Truncate(time.Second)) {
			continue
		}
		f.hosts[h] = certFailure{message: msg, at: at}
	}
	return true
}

// acmeFailureMarker starts Traefik's message for a failed order.
const acmeFailureMarker = "unable to obtain acme certificate"

var (
	reDomainsField = regexp.MustCompile(`domains=\[([^\]]*)\]`)
	reDomainsError = regexp.MustCompile(`for the domains \[([^\]]*)\]`)
	reErrorField   = regexp.MustCompile(`error="((?:[^"\\]|\\.)*)"`)
	reProblem      = regexp.MustCompile(`acme: error: (\d{3}) :: [^ ]+ :: (.*)`)
	reANSI         = regexp.MustCompile(`\x1b\[[0-9;]*m`)
)

// parseAcmeFailure returns the hosts and a short reason of an ACME failure
// line, and its time when the line carries one.
func parseAcmeFailure(line string) (hosts []string, msg string, at time.Time, ok bool) {
	// Traefik colours its text log even without a terminal.
	line = strings.TrimSpace(reANSI.ReplaceAllString(line, ""))
	if !strings.Contains(strings.ToLower(line), acmeFailureMarker) {
		return nil, "", time.Time{}, false
	}
	var errText string
	if strings.HasPrefix(line, "{") {
		var j struct {
			Time    string   `json:"time"`
			Error   string   `json:"error"`
			Domains []string `json:"domains"`
		}
		if json.Unmarshal([]byte(line), &j) == nil {
			errText, hosts = j.Error, j.Domains
			at, _ = time.Parse(time.RFC3339, j.Time)
		}
	} else {
		if m := reErrorField.FindStringSubmatch(line); m != nil {
			if s, err := strconv.Unquote(`"` + m[1] + `"`); err == nil {
				errText = s
			} else {
				errText = m[1]
			}
		}
		if m := reDomainsField.FindStringSubmatch(line); m != nil {
			hosts = splitDomains(m[1])
		}
		if f := strings.Fields(line); len(f) > 0 {
			at, _ = time.Parse(time.RFC3339, f[0])
		}
	}
	if len(hosts) == 0 {
		if m := reDomainsError.FindStringSubmatch(errText); m != nil {
			hosts = splitDomains(m[1])
		}
	}
	if len(hosts) == 0 {
		return nil, "", time.Time{}, false
	}
	return hosts, acmeReason(errText), at, true
}

func splitDomains(s string) []string {
	var out []string
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return r == ' ' || r == ',' }) {
		f = strings.Trim(f, `"'\`)
		if f != "" {
			out = append(out, f)
		}
	}
	return out
}

// acmeReason shortens the CA's error to what a person needs: the problem
// detail ("Invalid response from http://...: 404") when there is one.
func acmeReason(errText string) string {
	errText = strings.TrimSpace(errText)
	if m := reProblem.FindStringSubmatch(errText); m != nil {
		return "The certificate authority refused the certificate (" + m[1] + "): " + strings.TrimRight(strings.TrimSpace(m[2]), "]")
	}
	if errText == "" {
		return "The certificate authority could not issue the certificate (see the Traefik log)"
	}
	const max = 400
	if len(errText) > max {
		errText = errText[:max] + "..."
	}
	return "The certificate authority could not issue the certificate: " + errText
}

// LogFollower streams a container's log lines (stdout and stderr) from
// since until ctx ends. MobyDocker implements it.
type LogFollower interface {
	FollowLogs(ctx context.Context, name string, since time.Time, fn func(line string)) error
}

// WatchCertFailures follows the Traefik containers' logs into f until ctx
// ends, starting a day back so failures from before an agent restart
// count. Errors (container recreated, Docker restarting) are retried.
func WatchCertFailures(ctx context.Context, logs LogFollower, containers func(context.Context) ([]string, error), f *CertFailures) error {
	start := time.Now().Add(-failureTTL)
	delay := time.Second
	for ctx.Err() == nil {
		names, err := containers(ctx)
		if err == nil && len(names) > 0 {
			var wg sync.WaitGroup
			for _, name := range names {
				wg.Go(func() {
					_ = logs.FollowLogs(ctx, name, start, func(line string) { f.Observe(line) })
				})
			}
			wg.Wait()
			start = time.Now()
		}
		select {
		case <-ctx.Done():
		case <-time.After(delay):
		}
		delay = min(delay*2, 30*time.Second)
	}
	return nil
}

// certInfo is what route status shows about a certificate.
type certInfo struct {
	issuer   string
	notAfter time.Time
}

// leafInfo reads the first certificate of a PEM chain.
func leafInfo(chain []byte) (certInfo, error) {
	var block *pem.Block
	for {
		block, chain = pem.Decode(chain)
		if block == nil || block.Type == "CERTIFICATE" {
			break
		}
	}
	if block == nil {
		return certInfo{}, errors.New("no PEM certificate")
	}
	c, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return certInfo{}, err
	}
	issuer := c.Issuer.CommonName
	if issuer == "" && len(c.Issuer.Organization) > 0 {
		issuer = c.Issuer.Organization[0]
	}
	return certInfo{issuer: issuer, notAfter: c.NotAfter}, nil
}

// scanLines calls fn for each line of r (log streams).
func scanLines(r io.Reader, fn func(string)) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		fn(sc.Text())
	}
	return sc.Err()
}
