package proxy

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/seylo-dev/app/go/gen/brand"
)

// Entry points of the Traefik we write for. The Wings fork's Traefik uses
// the same names for web and websecure, so one route file works in both
// modes. LBEntryPoint only exists on the agent's own Traefik.
const (
	EntryPointWeb    = "web"
	EntryPointSecure = "websecure"
	// EntryPointLB receives load-balanced traffic from other nodes and
	// only routes to this node's replicas, so two nodes never bounce a
	// request between each other.
	EntryPointLB = brand.Slug + "-lb"
	// CertResolver is the ACME resolver name, the same as the Wings fork's.
	CertResolver = "le"
)

// Paths the agent's edge listener serves. Traefik rewrites matching
// requests to them; the prefix is unlikely to clash with an app's own.
const (
	// InternalPrefix starts every agent-owned path.
	InternalPrefix = "/_" + brand.Slug
	// MaintenancePath + "/<service id>" is the maintenance page.
	MaintenancePath = InternalPrefix + "/page/maintenance"
	// StatusPath + "/<service id>" is the status (down) page.
	StatusPath = InternalPrefix + "/page/status"
	// HandoffPath takes cookies handed over from an IP:port redirect.
	HandoffPath = InternalPrefix + "/handoff"
	// TicketPath?t=<ticket>[&to=/path] exchanges a panel-signed ticket for
	// a tool cookie, then redirects (to "/" by default).
	TicketPath = InternalPrefix + "/ticket"
	// ProbePath + "/<service id>/<version>" is the rollout probe.
	ProbePath = InternalPrefix + "/probe"
	// OriginPath + "<challenge>" is the origin proof the panel fetches on a
	// service's domains (edge/origin.go). Not under InternalPrefix: it is a
	// well-known path of the domain, routed on every service host.
	OriginPath = "/.well-known/" + brand.Slug + "-origin/"
	// AcmeChallengePath + "<token>" is Let's Encrypt's HTTP-01 challenge.
	// Traefik answers it on the challenge's entry point (web) by itself;
	// route files with Route.acme_challenge_on_https send it to
	// AcmeChallengeService on websecure too, for a CA that followed a
	// redirect to https in front of the node (a Cloudflare Redirect Rule or
	// Page Rule for every path; Cloudflare's Always Use HTTPS itself leaves
	// this path alone).
	AcmeChallengePath = "/.well-known/acme-challenge/"
)

// AcmeChallengeService is Traefik's own HTTP-01 challenge handler. It
// exists whenever a resolver has the HTTP challenge on, which the agent's
// Traefik and the Wings fork's both have (resolver CertResolver).
const AcmeChallengeService = "acme-http@internal"

// PageContentSecurityPolicy is sent with every page the edge serves on a
// service's domains (maintenance, status and its own default pages): a
// custom page is HTML anyone with the right to edit the service uploads,
// and it must not run scripts on the app's origin, frame, or be framed.
// Styles, images and fonts may come inline or over HTTPS. The panel's
// docs and the maintenance ops promise exactly this.
const PageContentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline' https:; img-src https: data:; font-src https: data:; frame-ancestors 'none'"

// Headers Traefik sets on requests it forwards to the edge, and the probe.
var (
	// HeaderTool names the tool ("box:<id>", "db-ui:<id>") a request to the
	// edge is for. Traefik overwrites any value the client sent.
	HeaderTool = "X-" + brandTitle + "-Tool"
	// HeaderProbe carries the agent's probe secret.
	HeaderProbe = "X-" + brandTitle + "-Probe"
	// HeaderRoute is added to probe answers: the route file version that
	// served them.
	HeaderRoute = "X-" + brandTitle + "-Route"
)

// brandTitle is the slug with a capital first letter, for header names.
var brandTitle = strings.ToUpper(brand.Slug[:1]) + brand.Slug[1:]

var (
	idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	// Host names: lower-case DNS labels. No wildcards, no backticks (they
	// would break out of a rule).
	hostPattern = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	pathPattern = regexp.MustCompile(`^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$`)
)

func checkID(kind, id string) error {
	if !idPattern.MatchString(id) {
		return fmt.Errorf("%w: %s id %q", ErrInvalidRoute, kind, id)
	}
	return nil
}

func checkHost(host string) error {
	if len(host) > 253 || !hostPattern.MatchString(host) {
		return fmt.Errorf("%w: host %q", ErrInvalidRoute, host)
	}
	return nil
}

func checkPath(path string) error {
	if !pathPattern.MatchString(path) || strings.Contains(path, "//") {
		return fmt.Errorf("%w: path %q", ErrInvalidRoute, path)
	}
	return nil
}

// checkUpstream accepts http(s)://host[:port] with an optional path.
func checkUpstream(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || strings.ContainsAny(raw, "`\n") {
		return fmt.Errorf("%w: upstream %q", ErrInvalidRoute, raw)
	}
	return nil
}

// namer builds the Traefik names of one service's routers, middlewares
// and services. Every name starts with seylo-<service>, so files of two
// services never collide in Traefik's merged configuration.
type namer struct{ base string }

func newNamer(serviceID string) namer { return namer{base: brand.Slug + "-" + serviceID} }

func (n namer) svc(suffix string) string {
	if suffix == "" {
		return n.base
	}
	return n.base + "-" + suffix
}

func (n namer) route(routeID, suffix string) string {
	name := n.base + "-r-" + routeID
	if suffix != "" {
		name += "-" + suffix
	}
	return name
}
