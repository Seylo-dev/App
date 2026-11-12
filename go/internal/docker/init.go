package docker

import (
	"path"
	"strings"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// InitFor decides ContainerSpec.Init for a service container
// (ContainerConfig.init):
//
//   - INIT_MODE_UNSPECIFIED: nil, the daemon's default, as before 0.2.14
//     (specs of generations deployed before then carry it, so the
//     containers they describe are made the same way again).
//   - INIT_MODE_ON: true. INIT_MODE_OFF: false.
//   - INIT_MODE_AUTO: true, unless the image runs an init of its own as
//     PID 1 (OwnInit): false then.
//
// entrypoint and cmd are the spec's overrides (empty keeps the image's);
// img is the image as InspectImage returns it.
func InitFor(mode agentv1.InitMode, entrypoint, cmd []string, img Image) *bool {
	on, off := true, false
	switch mode {
	case agentv1.InitMode_INIT_MODE_ON:
		return &on
	case agentv1.InitMode_INIT_MODE_OFF:
		return &off
	case agentv1.InitMode_INIT_MODE_AUTO:
		if OwnInit(MainProgram(entrypoint, cmd, img)) {
			return &off
		}
		return &on
	}
	return nil
}

// MainProgram is the program a container runs as its main process: the
// first word of its entrypoint (the spec's when set, else the image's), or
// without one, of its command (the spec's when set, else the image's).
// Docker drops the image's CMD when the entrypoint is overridden, which
// does not change the first word.
func MainProgram(entrypoint, cmd []string, img Image) string {
	ep := entrypoint
	if len(ep) == 0 {
		ep = img.Entrypoint
	}
	if len(ep) > 0 {
		return ep[0]
	}
	c := cmd
	if len(c) == 0 {
		c = img.Cmd
	}
	if len(c) > 0 {
		return c[0]
	}
	return ""
}

// OwnInit reports whether program is an init that must be PID 1 itself or
// already does what docker-init does, by its base name: init (s6-overlay's
// /init in linuxserver.io images, /sbin/init), systemd, tini and tini-*
// (tini-static), dumb-init, docker-init, catatonit, and s6-* (s6-svscan,
// s6-overlay-suexec). Docker's init in front of them would take PID 1:
// s6-overlay and systemd refuse to start, Tini warns that it cannot reap.
func OwnInit(program string) bool {
	base := path.Base(strings.TrimSpace(program))
	switch base {
	case "init", "systemd", "tini", "dumb-init", "docker-init", "catatonit":
		return true
	}
	return strings.HasPrefix(base, "tini-") || strings.HasPrefix(base, "s6-")
}
