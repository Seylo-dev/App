package edge

import (
	"html/template"
	"sync"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// pages holds the maintenance and status pages from the desired state, so
// they keep working while the panel is unreachable.
type pages struct {
	mu       sync.RWMutex
	global   *agentv1.Maintenance
	services map[string]*agentv1.Routing
}

func (p *pages) set(desired *agentv1.DesiredState) {
	services := map[string]*agentv1.Routing{}
	for _, s := range desired.GetServices() {
		if r := s.GetRouting(); r != nil {
			services[s.GetId()] = proto.Clone(r).(*agentv1.Routing)
		}
	}
	var global *agentv1.Maintenance
	if g := desired.GetSettings().GetMaintenance(); g != nil {
		global = proto.Clone(g).(*agentv1.Maintenance)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.global, p.services = global, services
}

// maintenance returns the custom HTML of the page that applies (global
// first), "" for the default page.
func (p *pages) maintenance(serviceID string) string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.global.GetEnabled() {
		return p.global.GetHtml()
	}
	return p.services[serviceID].GetMaintenance().GetHtml()
}

// status returns the custom HTML and whether the status page is enabled.
// A service the agent does not know gets the default page.
func (p *pages) status(serviceID string) (string, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	r, ok := p.services[serviceID]
	if !ok || r.GetStatusPage() == nil {
		return "", true
	}
	return r.GetStatusPage().GetHtml(), r.GetStatusPage().GetEnabled()
}

// Default pages: neutral (white label), no product name, no external assets.
var defaultPage = template.Must(template.New("page").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{.Title}}</title>
<style>
:root{color-scheme:light dark;--bg:#f5f7fb;--card:#fff;--fg:#0f172a;--muted:#64748b}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--card:#131a2e;--fg:#e2e8f0;--muted:#94a3b8}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{background:var(--card);border-radius:12px;box-shadow:0 8px 30px rgba(15,23,42,.08);padding:40px 36px;max-width:420px;margin:16px;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{margin:0;color:var(--muted)}
</style></head>
<body><main><h1>{{.Title}}</h1><p>{{.Message}}</p></main></body></html>
`))

type pageText struct{ Title, Message string }

var (
	maintenanceText = pageText{"Down for maintenance", "This site is being worked on and will be back shortly."}
	statusText      = pageText{"This app is not available", "It is stopped or starting up. Try again in a moment."}
	signInText      = pageText{"Sign-in needed", "Open this tool from the panel to sign in."}
	toolDownText    = pageText{"Not available", "This tool is not running on this node right now. Try again from the panel."}
)
