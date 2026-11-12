package reconcile

import (
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// A background worker (a Dockerfile app with no domain that never listens
// on a port) keeps the port new app services get, 80, and the default
// check (TCP on the first port) is refused for the whole health timeout.
// The deploy error says nothing listens there and where in the web app the
// port goes away or a check that fits is set. Only for the default check
// refused all along: a check that timed out, an HTTP or command check, or
// a check of the service's own keeps the plain error.
func TestDeployNotListeningHint(t *testing.T) {
	const refused = "not healthy after 300ms: health check never passed: tcp check on port 80: dial tcp 172.29.0.9:80: connect: connection refused. "
	listen := " it must listen on port 80 on all addresses (0.0.0.0), not only on 127.0.0.1"
	for _, tc := range []struct {
		name string
		edit func(*agentv1.ServiceSpec)
		// plain: the image fails its check in another way.
		plain bool
		want  string
	}{
		{
			name: "a worker app without a domain",
			edit: func(s *agentv1.ServiceSpec) { s.Routing = nil },
			want: refused + "Nothing in the container listens on port 80. If this service does not serve on a port (a background worker), remove the port under Ports in the Container section of the service's Advanced tab (no domain uses it), " +
				"or set a check that fits it under Health check and deploys on the same tab. If it does serve," + listen + ".",
		},
		{
			name: "an app whose domain sends traffic to the port",
			want: refused + "Nothing in the container listens on port 80, where its domains send traffic:" + listen +
				", or Ports in the Container section of the service's Advanced tab and the domains must name the port it does listen on.",
		},
		{
			name: "a route without a target port goes to the first one",
			edit: func(s *agentv1.ServiceSpec) { s.Routing.Routes[0].TargetPort = 0 },
			want: refused + "Nothing in the container listens on port 80, where its domains send traffic:",
		},
		{
			name: "a domain on another port",
			edit: func(s *agentv1.ServiceSpec) {
				s.Ports = append(s.Ports, &agentv1.PortSpec{ContainerPort: 3000, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_TCP})
				s.Routing.Routes[0].TargetPort = 3000
			},
			want: refused + "Nothing in the container listens on port 80. If this service does not serve on a port (a background worker), remove the port under Ports",
		},
		{
			name: "a compose member",
			edit: func(s *agentv1.ServiceSpec) { s.Kind, s.Routing = agentv1.ServiceKind_SERVICE_KIND_COMPOSE_MEMBER, nil },
			want: refused + "Nothing in the container listens on port 80. If this service does not serve on a port (a background worker), remove its ports and expose entries from the stack's compose file on the stack's Compose file tab (no domain uses them), " +
				"or give it a healthcheck there that fits it. If it does serve," + listen + ".",
		},
		{
			name: "a TCP check of its own",
			edit: func(s *agentv1.ServiceSpec) {
				s.Routing = nil
				s.HealthCheck = &agentv1.HealthCheck{Probe: &agentv1.HealthCheck_Tcp{Tcp: &agentv1.TcpProbe{Port: 80}}}
			},
		},
		{
			name:  "timed out, or another check",
			edit:  func(s *agentv1.ServiceSpec) { s.Routing = nil },
			plain: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			s1 := appSpec("svc", 1, "app:v1")
			if tc.edit != nil {
				tc.edit(s1)
			}
			h.apply(1, s1)
			if p := h.deployResult("svc", 1); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
				t.Fatalf("gen 1 = %v", p)
			}
			if tc.plain {
				h.prober.setBad("app:worker", true)
			} else {
				h.prober.setRefused("app:worker")
			}
			h.apply(2, cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) { s.Image.Reference = "app:worker" }))
			p := h.deployResult("svc", 2)
			if p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED {
				t.Fatalf("gen 2 = %v", p)
			}
			msg, _, _ := strings.Cut(p.GetMessage(), "\nlast output:")
			t.Logf("%s", msg)
			if tc.want == "" {
				if !strings.HasPrefix(msg, "not healthy after 300ms: health check never passed") || strings.Contains(msg, "Nothing in the container") {
					t.Fatalf("message = %q, want the plain error", msg)
				}
				return
			}
			if !strings.HasPrefix(msg, tc.want) {
				t.Fatalf("message\n got: %s\nwant: %s", msg, tc.want)
			}
			// The status and the service log carry it too.
			if st := h.state.get("svc"); !strings.Contains(st.GetMessage(), "Nothing in the container listens on port 80") {
				t.Fatalf("status message = %q", st.GetMessage())
			}
		})
	}
}
