package nodecheck

import (
	"context"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

func panelContainer(state string, ports ...DockerPort) DockerContainer {
	return DockerContainer{
		Names: []string{"/seylo-panel00000000000-4"}, State: state, Ports: ports,
		Labels: map[string]string{docker.LabelService: docker.PanelServiceID, docker.LabelProtected: "true"},
	}
}

// Docker before 28 with the panel published on 127.0.0.1 only ("Serve on
// IP address" off) warns: other machines on the same local network may
// still reach it. Open ports, Docker 28 and later, and a stopped panel pass.
func TestDockerEngineWarnsForLoopbackPanelOnOldDocker(t *testing.T) {
	closed := panelContainer("running",
		DockerPort{IP: "127.0.0.1", PrivatePort: 3000, PublicPort: 3000, Type: "tcp"},
		DockerPort{IP: "0.0.0.0", PrivatePort: 3443, PublicPort: 3443, Type: "tcp"},
		DockerPort{IP: "::", PrivatePort: 3443, PublicPort: 3443, Type: "tcp"})
	open := panelContainer("running",
		DockerPort{IP: "0.0.0.0", PrivatePort: 3000, PublicPort: 3000, Type: "tcp"},
		DockerPort{IP: "::", PrivatePort: 3000, PublicPort: 3000, Type: "tcp"})
	notPanel := DockerContainer{State: "running", Labels: map[string]string{docker.LabelService: "svc"},
		Ports: []DockerPort{{IP: "127.0.0.1", PrivatePort: 80, PublicPort: 8080, Type: "tcp"}}}
	for name, tc := range map[string]struct {
		version    string
		containers []DockerContainer
		want       agentv1.NodeCheckStatus
	}{
		"27 closed":        {"27.5.1", []DockerContainer{closed}, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN},
		"24 closed":        {"24.0.7", []DockerContainer{closed}, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN},
		"27 open":          {"27.5.1", []DockerContainer{open}, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS},
		"27 stopped":       {"27.5.1", []DockerContainer{panelContainer("exited")}, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS},
		"27 other service": {"27.5.1", []DockerContainer{notPanel}, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS},
		"28 closed":        {"28.0.1", []DockerContainer{closed}, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS},
		"20 closed":        {"20.10.24", []DockerContainer{closed}, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL},
	} {
		env := Env{Docker: fakeDocker{info: &DockerInfo{ServerVersion: tc.version, Driver: "overlay2"}, publishers: tc.containers}}
		env.defaults()
		r := env.dockerEngine(context.Background())
		if r.GetStatus() != tc.want {
			t.Errorf("%s = %v", name, r)
			continue
		}
		if tc.want == agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN {
			if !strings.Contains(r.GetDetail(), "the panel is published on 127.0.0.1:3000 only") || strings.Contains(r.GetDetail(), "3443") {
				t.Errorf("%s detail = %q", name, r.GetDetail())
			}
			if !strings.Contains(r.GetFixHint(), "Update Docker to 28 or newer") || !strings.Contains(r.GetFixHint(), "local network") {
				t.Errorf("%s hint = %q", name, r.GetFixHint())
			}
		}
	}

	// The storage driver's own hint stays.
	env := Env{Docker: fakeDocker{info: &DockerInfo{ServerVersion: "27.5.1", Driver: "vfs"}, publishers: []DockerContainer{closed}}}
	env.defaults()
	if r := env.dockerEngine(context.Background()); !strings.Contains(r.GetFixHint(), "overlay2 is the tested storage driver") {
		t.Errorf("vfs hint = %q", r.GetFixHint())
	}
}
