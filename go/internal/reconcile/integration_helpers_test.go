//go:build integration

package reconcile

import (
	"io/fs"
	"os/exec"
	"syscall"

	gproto "google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func cloneOf(s *agentv1.ServiceSpec) *agentv1.ServiceSpec {
	return gproto.Clone(s).(*agentv1.ServiceSpec)
}

// The foreign resources are made with the docker CLI on purpose: nothing
// of ours (labels, cgroup parent) touches them.
func createUnmanagedNetwork(name string) error {
	return exec.Command("docker", "network", "create", name).Run()
}

func createUnmanagedContainer(name, image string) error {
	return exec.Command("docker", "run", "-d", "--name", name, image, "sleep", "600").Run()
}

func networkExists(name string) bool {
	return exec.Command("docker", "network", "inspect", name).Run() == nil
}

func ownerOf(info fs.FileInfo) (int, int) {
	st := info.Sys().(*syscall.Stat_t)
	return int(st.Uid), int(st.Gid)
}
