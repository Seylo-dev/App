package docker

import (
	"context"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func initText(p *bool) string {
	switch {
	case p == nil:
		return "daemon default"
	case *p:
		return "on"
	}
	return "off"
}

func TestInitForModes(t *testing.T) {
	node := Image{Cmd: []string{"node", "server.js"}}
	s6 := Image{Entrypoint: []string{"/init"}}
	cases := []struct {
		name       string
		mode       agentv1.InitMode
		entrypoint []string
		cmd        []string
		img        Image
		want       string
	}{
		// Specs from before 0.2.14: as they were made.
		{"unspecified", agentv1.InitMode_INIT_MODE_UNSPECIFIED, nil, nil, node, "daemon default"},
		{"on", agentv1.InitMode_INIT_MODE_ON, nil, nil, s6, "on"},
		{"off", agentv1.InitMode_INIT_MODE_OFF, nil, nil, node, "off"},
		{"auto node", agentv1.InitMode_INIT_MODE_AUTO, nil, nil, node, "on"},
		{"auto bun entrypoint", agentv1.InitMode_INIT_MODE_AUTO, nil, nil, Image{Entrypoint: []string{"/usr/local/bin/docker-entrypoint.sh"}, Cmd: []string{"bun", "app.ts"}}, "on"},
		// linuxserver.io images: s6-overlay's /init must be PID 1.
		{"auto s6-overlay", agentv1.InitMode_INIT_MODE_AUTO, nil, nil, s6, "off"},
		{"auto s6 with a command", agentv1.InitMode_INIT_MODE_AUTO, nil, []string{"nginx"}, s6, "off"},
		{"auto tini entrypoint", agentv1.InitMode_INIT_MODE_AUTO, nil, nil, Image{Entrypoint: []string{"/sbin/tini", "--"}, Cmd: []string{"node"}}, "off"},
		{"auto tini-static", agentv1.InitMode_INIT_MODE_AUTO, nil, nil, Image{Entrypoint: []string{"/tini-static", "--", "app"}}, "off"},
		{"auto dumb-init", agentv1.InitMode_INIT_MODE_AUTO, nil, nil, Image{Entrypoint: []string{"dumb-init", "--"}}, "off"},
		{"auto s6-svscan command", agentv1.InitMode_INIT_MODE_AUTO, nil, nil, Image{Cmd: []string{"/command/s6-svscan", "/etc/s6"}}, "off"},
		{"auto systemd", agentv1.InitMode_INIT_MODE_AUTO, nil, nil, Image{Cmd: []string{"/lib/systemd/systemd"}}, "off"},
		// The spec's entrypoint replaces the image's.
		{"auto spec entrypoint over s6", agentv1.InitMode_INIT_MODE_AUTO, []string{"node"}, nil, s6, "on"},
		{"auto spec tini entrypoint", agentv1.InitMode_INIT_MODE_AUTO, []string{"tini", "--"}, nil, node, "off"},
		// The spec's command counts only without an entrypoint.
		{"auto spec command", agentv1.InitMode_INIT_MODE_AUTO, nil, []string{"/init"}, Image{}, "off"},
		{"auto empty image", agentv1.InitMode_INIT_MODE_AUTO, nil, nil, Image{}, "on"},
		// A program merely named like one is not an init.
		{"auto initialize", agentv1.InitMode_INIT_MODE_AUTO, nil, nil, Image{Cmd: []string{"/app/init-db"}}, "on"},
	}
	for _, c := range cases {
		if got := initText(InitFor(c.mode, c.entrypoint, c.cmd, c.img)); got != c.want {
			t.Errorf("%s: init %s, want %s", c.name, got, c.want)
		}
	}
}

// CreateContainer sends HostConfig.Init only when the spec decides it.
func TestCreateContainerInit(t *testing.T) {
	on, off := true, false
	for _, c := range []struct {
		init *bool
		want any
	}{{nil, nil}, {&on, true}, {&off, false}} {
		f := &fakeDaemon{}
		m := newFakeMoby(t, f)
		if _, err := m.CreateContainer(context.Background(), ContainerSpec{Name: "x", Image: "app:1", Init: c.init}); err != nil {
			t.Fatal(err)
		}
		f.mu.Lock()
		host, _ := f.created["HostConfig"].(map[string]any)
		got, set := host["Init"]
		f.mu.Unlock()
		if c.want == nil && set {
			t.Errorf("init %s: HostConfig.Init = %v, want it left out", initText(c.init), got)
		}
		if c.want != nil && got != c.want {
			t.Errorf("init %s: HostConfig.Init = %v, want %v", initText(c.init), got, c.want)
		}
	}
}
