package proxy

import (
	"regexp"
	"slices"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/geoip"
	"go.yaml.in/yaml/v3"
)

// The forwardAuth middleware deletes every spelling of the header a client
// could send that an app may read as X-Seylo-Country.
func TestCountryHeaderPattern(t *testing.T) {
	re := regexp.MustCompile(geoip.HeaderPattern)
	// Go canonicalizes on dashes only, so these reach Traefik as different
	// names; CGI and nginx turn each into HTTP_X_SEYLO_COUNTRY.
	for _, name := range []string{"X-Seylo-Country", "X_seylo_country", "X.seylo.country", "X-Seylo_country", "X~seylo!country", "x-SEYLO-country"} {
		if !re.MatchString(name) {
			t.Errorf("%q is not deleted", name)
		}
	}
	for _, name := range []string{"X-Seylo-Countryx", "X-Seylo-Country-Code", "Xseylocountry", "X--Seylo-Country", "X-Seylo-Route", "Cf-Ipcountry"} {
		if re.MatchString(name) {
			t.Errorf("%q is deleted", name)
		}
	}
	if !slices.Contains(geoip.HeaderAliases(), "X-Seylo-Country") || !slices.Contains(geoip.HeaderAliases(), "X_Seylo_Country") {
		t.Errorf("HeaderAliases() = %v", geoip.HeaderAliases())
	}
}

func countryMiddlewares(t *testing.T, in BuildInput) (routers map[string]*router, mws map[string]*middleware) {
	t.Helper()
	built, err := Build(in)
	if err != nil {
		t.Fatal(err)
	}
	var cfg dynamicConfig
	if err := yaml.Unmarshal(built.Data, &cfg); err != nil {
		t.Fatal(err)
	}
	return cfg.HTTP.Routers, cfg.HTTP.Middlewares
}

// Every router that reaches the app has exactly one country middleware,
// in both states; routers that never reach the app have none.
func TestCountryOnEveryAppRouter(t *testing.T) {
	for _, on := range []bool{true, false} {
		in := BuildInput{
			Service:      app("svc1", route("r1", "a.example.com"), onHTTPS(route("r2", "b.example.com"))),
			Upstreams:    ups("http://seylo-svc1-1:3000"),
			Edge:         testEdge,
			ProbeSecret:  "s3cret",
			Settings:     &agentv1.NodeSettings{LbTls: fakeLBTLS},
			LBEntryPoint: true,
		}
		in.Service.LoadBalancer = &agentv1.LoadBalancer{RemoteUpstreams: []*agentv1.RemoteUpstream{{NodeId: "n2", Url: "https://198.51.100.2:5757"}}}
		if on {
			in.Country = CountryLookup{Address: "http://172.30.0.1:5758/", MaxResponseBodySize: true}
		}
		routers, mws := countryMiddlewares(t, in)
		for name, r := range routers {
			n := 0
			for _, m := range r.Middlewares {
				mw := mws[m]
				if mw == nil {
					t.Fatalf("%s uses missing middleware %s", name, m)
				}
				if mw.ForwardAuth != nil {
					n++
					if !on {
						t.Errorf("header off: %s asks the lookup server", name)
					}
					fa := mw.ForwardAuth
					if !fa.TrustForwardHeader || fa.AuthResponseHeadersRegex != geoip.HeaderPattern || fa.MaxResponseBodySize == nil || *fa.MaxResponseBodySize != countryBodyLimit {
						t.Errorf("%s: forwardAuth %+v", name, fa)
					}
				}
				if v, ok := mw.Headers.requestHeader(geoip.Header); ok && v == "" {
					n++
					if on {
						t.Errorf("header on: %s only strips", name)
					}
				}
			}
			// Redirect-only routers never forward; the rollout probe is
			// the agent's own request.
			redirects := slices.ContainsFunc(r.Middlewares, func(m string) bool { return mws[m].RedirectScheme != nil })
			toApp := (r.Service == "seylo-svc1" || r.Service == "seylo-svc1-local" || r.Service == "seylo-svc1-idem" || r.Service == "seylo-svc1-others") &&
				!redirects && name != "seylo-svc1-probe"
			switch {
			case toApp && n != 1:
				t.Errorf("on=%v: %s reaches the app with %d country middlewares (%v)", on, name, n, r.Middlewares)
			case !toApp && n != 0:
				t.Errorf("on=%v: %s (to %s) has a country middleware", on, name, r.Service)
			}
		}
	}
}

func (h *headers) requestHeader(name string) (string, bool) {
	if h == nil {
		return "", false
	}
	v, ok := h.CustomRequestHeaders[name]
	return v, ok
}
