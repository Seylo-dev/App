package reconcile

import (
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// procTCP is a /proc/<pid>/net/tcp with one LISTEN socket per address, as
// a little-endian kernel prints them ("0100007F:1770" is 127.0.0.1:6000).
func procTCP(addrs ...string) string {
	out := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
	for _, a := range addrs {
		out += "   0: " + a + " 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0 100 0 0 10 0\n"
	}
	return out
}

// A background worker (a Dockerfile app with no domain that never listens
// on a port) keeps the port new app services get, 80, and the default
// check (TCP on the first port) is refused for the whole health timeout.
// The deploy error says nothing listens there and where in the web app the
// port goes away or a check that fits is set. Only for the default check
// refused all along: a check that timed out, an HTTP or command check, or
// a check of the service's own keeps the plain error.
//
// Since 0.2.16 the agent reads what the container listens on instead
// (its /proc/<pid>/net/tcp and tcp6) before removing it: another port
// ("The app listens on port 6000, not 80."), or only a loopback address.
// The result carries it as not_listening, for the panel's "Use port".
func TestDeployNotListeningHint(t *testing.T) {
	const refused = "not healthy after 300ms: health check never passed: tcp check on port 80: dial tcp 172.29.0.9:80: connect: connection refused. "
	listen := " it must listen on port 80 on all addresses (0.0.0.0), not only on 127.0.0.1"
	for _, tc := range []struct {
		name string
		edit func(*agentv1.ServiceSpec)
		// plain: the image fails its check in another way.
		plain bool
		// tcp: what /proc/<pid>/net/tcp of the new container says ("": not readable).
		tcp  string
		want string
		// listening: DeployProgress.not_listening (nil: unset).
		listening *agentv1.NotListening
	}{
		{
			name: "a worker app without a domain",
			edit: func(s *agentv1.ServiceSpec) { s.Routing = nil },
			want: refused + "Nothing in the container listens on port 80. If this service does not serve on a port (a background worker), remove the port under Ports in the Container section of the service's Advanced tab (no domain uses it), " +
				"or set a check that fits it under Health check and deploys on the same tab. If it does serve," + listen + ".",
			listening: &agentv1.NotListening{Port: 80},
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
			name: "it listens on another port",
			tcp:  procTCP("00000000:1770", "0100007F:2405"),
			want: refused + "The app listens on port 6000, not 80. Set the service's port to 6000 (Ports in the Container section of its Advanced tab) and point its domains there, or make the app listen on port 80.",
			listening: &agentv1.NotListening{Port: 80, Read: true, Listening: []*agentv1.ListeningPort{
				{Port: 6000}, {Port: 9221, LoopbackOnly: true},
			}},
		},
		{
			name: "several other ports, no domain",
			edit: func(s *agentv1.ServiceSpec) { s.Routing = nil },
			tcp:  procTCP("00000000:0BB8", "00000000:1770"),
			want: refused + "The app listens on ports 3000 and 6000, not 80. Set the service's port to 3000 (Ports in the Container section of its Advanced tab), or make the app listen on port 80.",
		},
		{
			name: "a compose member on another port",
			edit: func(s *agentv1.ServiceSpec) { s.Kind = agentv1.ServiceKind_SERVICE_KIND_COMPOSE_MEMBER },
			tcp:  procTCP("00000000:1770"),
			want: refused + "The app listens on port 6000, not 80. Name port 6000 instead in the stack's compose file (its Compose file tab) and point its domains there, or make the app listen on port 80.",
		},
		{
			name: "only on loopback, another port",
			tcp:  procTCP("0100007F:1770"),
			want: refused + "The app listens only on 127.0.0.1:6000; it must listen on 0.0.0.0 (all addresses), on port 80 (or the service's port must be 6000).",
			listening: &agentv1.NotListening{Port: 80, Read: true, Listening: []*agentv1.ListeningPort{
				{Port: 6000, LoopbackOnly: true},
			}},
		},
		{
			name: "only on loopback, the checked port",
			tcp:  procTCP("0100007F:1770", "0100007F:0050"),
			want: refused + "The app listens only on 127.0.0.1:80; it must listen on 0.0.0.0 (all addresses) for the health check and its domains to reach it.",
		},
		{
			// A Node inspector (9229) or a metrics port on all addresses
			// is no port to switch to: 80 on 127.0.0.1 is the mistake.
			name: "only on loopback on the checked port, another port on all addresses",
			tcp:  procTCP("0100007F:0050", "00000000:2405"),
			want: refused + "The app listens only on 127.0.0.1:80; it must listen on 0.0.0.0 (all addresses) for the health check and its domains to reach it.",
			listening: &agentv1.NotListening{Port: 80, Read: true, Listening: []*agentv1.ListeningPort{
				{Port: 80, LoopbackOnly: true}, {Port: 9221},
			}},
		},
		{
			name:      "it listens on nothing",
			edit:      func(s *agentv1.ServiceSpec) { s.Routing = nil },
			tcp:       procTCP(),
			want:      refused + "Nothing in the container listens on port 80. If this service does not serve on a port (a background worker)",
			listening: &agentv1.NotListening{Port: 80, Read: true},
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
			switch {
			case tc.plain:
				h.prober.setBad("app:worker", true)
			case tc.tcp != "":
				h.prober.setListening("app:worker", tc.tcp)
			default:
				h.prober.setRefused("app:worker")
			}
			h.eng.SetLogs("seylo-svc-2", "Server is running on port 6000", "Heartbeat")
			h.apply(2, cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) { s.Image.Reference = "app:worker" }))
			p := h.deployResult("svc", 2)
			if p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED {
				t.Fatalf("gen 2 = %v", p)
			}
			msg := p.GetMessage()
			t.Logf("%s", msg)
			// The app's output is apart from the reason.
			if strings.Contains(msg, "Heartbeat") || strings.Contains(msg, "last output") ||
				strings.Join(p.GetLastOutput(), "|") != "Server is running on port 6000|Heartbeat" {
				t.Fatalf("message %q, last output %q", msg, p.GetLastOutput())
			}
			if tc.want == "" {
				if !strings.HasPrefix(msg, "not healthy after 300ms: health check never passed") || strings.Contains(msg, "Nothing in the container") || strings.Contains(msg, "The app listens") {
					t.Fatalf("message = %q, want the plain error", msg)
				}
				if p.GetNotListening() != nil {
					t.Fatalf("not listening = %v", p.GetNotListening())
				}
				return
			}
			if !strings.HasPrefix(msg, tc.want) {
				t.Fatalf("message\n got: %s\nwant: %s", msg, tc.want)
			}
			if p.GetNotListening().GetPort() != 80 {
				t.Fatalf("not listening = %v", p.GetNotListening())
			}
			if tc.listening != nil && !proto.Equal(p.GetNotListening(), tc.listening) {
				t.Fatalf("not listening\n got: %v\nwant: %v", p.GetNotListening(), tc.listening)
			}
			// The status and the service log carry it too.
			hint := strings.TrimPrefix(tc.want, refused)
			if i := strings.Index(hint, "."); i > 0 {
				hint = hint[:i]
			}
			if st := h.state.get("svc"); !strings.Contains(st.GetMessage(), hint) {
				t.Fatalf("status message = %q, want %q", st.GetMessage(), hint)
			}
		})
	}
}
