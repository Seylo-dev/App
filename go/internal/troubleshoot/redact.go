package troubleshoot

import (
	"regexp"
	"strings"

	"github.com/seylo-dev/app/go/gen/brand"
)

// Marker replaces every secret. The site API accepts it as redacted.
const Marker = "[REDACTED]"

// RedactOptions picks the optional rules.
type RedactOptions struct {
	// Emails replaces email addresses (on by default in Options).
	Emails bool
	// IPs replaces IPv4 and IPv6 addresses, except loopback and private
	// ranges people need to debug networking.
	IPs bool
}

type rule struct {
	re *regexp.Regexp
	// replace builds the replacement from the submatches; nil replaces the
	// whole match.
	replace func(m []string) string
}

func whole(pattern string) rule { return rule{re: regexp.MustCompile(pattern)} }

// keepFirst keeps group 1 and replaces the rest of the match.
func keepFirst(pattern string) rule {
	return rule{re: regexp.MustCompile(pattern), replace: func(m []string) string { return m[1] + Marker }}
}

// Rules mirror (and go beyond) the site API's refusal rules (in the
// private Website repo), so an upload is never refused for a secret this
// package should have caught.
var secretRules = []rule{
	// Tokens with a recognisable shape, anywhere in a line.
	whole(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`),
	whole(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b`),
	whole(`\bxox[abprs]-[A-Za-z0-9-]{10,}`),
	whole(`\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}`),
	whole(`\bsk-ant-[A-Za-z0-9_-]{10,}`),
	whole(`\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}`),
	whole(`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`),
	// Our own API keys, MCP tokens and join tokens.
	whole(`\b` + regexp.QuoteMeta(brand.Slug) + `_(?:key|mcp|join|setup)_[A-Za-z0-9_-]{8,}`),
	// Setup and ticket links: ?t=... carries a secret.
	keepFirst(`([?&](?:t|token|ticket|code|key|secret|signature|sig)=)[^\s&"'#]+`),
	// user:password@host in URLs.
	keepFirst(`(\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s:@/]+:)[^\s@/]+@`),
	// Authorization headers.
	keepFirst(`(?i)(\bauthorization\s*[:=]\s*(?:bearer|basic|token)?\s*)[^\s"',]+`),
	keepFirst(`(?i)(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}`),
	// key: value and KEY=value assignments whose key names a secret,
	// including env vars like DB_PASSWORD or CLOUDFLARE_API_TOKEN.
	keepFirst(`(?i)(\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)[^\s"',]+`),
}

var (
	privateKeyBegin = regexp.MustCompile(`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----`)
	privateKeyEnd   = regexp.MustCompile(`-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----`)
	emailRule       = regexp.MustCompile(`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`)
	ipv4Rule        = regexp.MustCompile(`\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b`)
	ipv6Rule        = regexp.MustCompile(`\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b`)
)

// Redact removes secrets from text line by line. PEM private keys are cut
// out whole, including the lines between BEGIN and END.
func Redact(text string, opts RedactOptions) string {
	lines := strings.Split(text, "\n")
	inKey := false
	for i, line := range lines {
		if inKey {
			if privateKeyEnd.MatchString(line) {
				inKey = false
			}
			lines[i] = Marker
			continue
		}
		if privateKeyBegin.MatchString(line) {
			inKey = !privateKeyEnd.MatchString(line)
			lines[i] = Marker
			continue
		}
		lines[i] = redactLine(line, opts)
	}
	return strings.Join(lines, "\n")
}

func redactLine(line string, opts RedactOptions) string {
	for _, r := range secretRules {
		if r.replace == nil {
			line = r.re.ReplaceAllString(line, Marker)
			continue
		}
		line = r.re.ReplaceAllStringFunc(line, func(s string) string {
			m := r.re.FindStringSubmatch(s)
			if strings.HasPrefix(s[len(m[1]):], Marker) {
				return s
			}
			return r.replace(m)
		})
	}
	if opts.Emails {
		line = emailRule.ReplaceAllString(line, Marker)
	}
	if opts.IPs {
		line = ipv4Rule.ReplaceAllStringFunc(line, func(ip string) string {
			if keepIP(ip) {
				return ip
			}
			return Marker
		})
		line = ipv6Rule.ReplaceAllStringFunc(line, func(ip string) string {
			if strings.HasPrefix(strings.ToLower(ip), "fe80:") || strings.HasPrefix(strings.ToLower(ip), "fd") {
				return ip
			}
			return Marker
		})
	}
	return line
}

// keepIP keeps addresses that identify nobody: loopback, private ranges,
// Docker's default bridges and 0.0.0.0.
func keepIP(ip string) bool {
	for _, prefix := range []string{"127.", "10.", "192.168.", "0.0.0.0", "169.254."} {
		if strings.HasPrefix(ip, prefix) {
			return true
		}
	}
	if strings.HasPrefix(ip, "172.") {
		var second int
		for _, c := range strings.SplitN(ip, ".", 3)[1] {
			second = second*10 + int(c-'0')
		}
		return second >= 16 && second <= 31
	}
	return false
}
