package nodecheck

import (
	"context"
	"fmt"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/geoip"
)

// The visitor country header check (proxy.country, since 0.2.24): with
// NodeSettings.country_header on, the lookup server Traefik asks answers
// and has a recent country database. The agent's geoip upkeep reports it
// (Env.CountryHeader).

const countryHeaderTitle = "Visitor country header"

// countryDBMaxAge is how old a database gets before the check warns: DB-IP
// publishes monthly, so two months means downloads keep failing.
const countryDBMaxAge = 62 * 24 * time.Hour

const countryDownloadHint = "The node downloads the database from download.db-ip.com over HTTPS; allow that in an outbound firewall or proxy. " +
	"A MaxMind account in Settings > General is used when DB-IP cannot be reached."

// countryHeader is the proxy.country check.
func (e *Env) countryHeader(ctx context.Context) *agentv1.NodeCheckResult {
	if e.CountryHeader == nil {
		return skipped("only the agent checks the visitor country header")
	}
	return judgeCountryHeader(e.CountryHeader(ctx), e.Now())
}

// judgeCountryHeader turns the upkeep's report into the check's result.
func judgeCountryHeader(r *geoip.Report, now time.Time) *agentv1.NodeCheckResult {
	if r == nil || !r.Enabled {
		return skipped("the visitor country header is off")
	}
	if r.Listen == "" {
		return warn("the edge network is not set up yet, so the country lookup server has no address", "")
	}
	if r.HealthErr != "" {
		return fail(fmt.Sprintf("the country lookup server on %s does not answer (%s), so apps get no %s header; the agent keeps trying to start it",
			r.Listen, r.HealthErr, geoip.Header),
			"See systemctl status "+geoip.SocketUnit+" "+geoip.ServiceUnit+" and journalctl -u "+geoip.ServiceUnit+".")
	}
	if r.Unreachable != "" {
		return fail(fmt.Sprintf("Traefik cannot reach the country lookup server on %s (%s), so apps get no %s header", r.Listen, r.Unreachable, geoip.Header),
			fmt.Sprintf("Allow TCP to port %d from the %s bridge in the host firewall, as for the edge listener's 5756: with ufw, ufw allow in on %s to any port %d proto tcp (the agent adds that itself when ufw is active).",
				geoip.DefaultPort, docker.EdgeNetwork, docker.EdgeNetwork, geoip.DefaultPort))
	}
	db := r.Health.Database
	if db == nil {
		detail := fmt.Sprintf("no country database yet, so apps get %s: %s", geoip.Header, geoip.Unknown)
		if r.State.LastError != "" {
			detail += "; the last download failed: " + r.State.LastError
		}
		return warn(detail, countryDownloadHint)
	}
	source := db.Type
	switch r.State.Source {
	case geoip.SourceDBIP:
		source = "DB-IP IP to Country Lite " + r.State.Month
	case geoip.SourceMaxMind:
		source = "MaxMind GeoLite2 Country"
	}
	built := db.Built.Format(time.DateOnly)
	if now.Sub(db.Built) > countryDBMaxAge {
		detail := fmt.Sprintf("the country database (%s) was built %s, more than two months ago", source, built)
		if r.State.LastError != "" {
			detail += "; the last download failed: " + r.State.LastError
		}
		return warn(detail, countryDownloadHint)
	}
	if !r.Asked {
		return pass("the lookup server answers on %s with %s built %s; the route files ask it within seconds", r.Listen, source, built)
	}
	return pass("apps get %s from %s built %s", geoip.Header, source, built)
}
