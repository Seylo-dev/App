//go:build integration

package docker

import (
	"io"
	"strconv"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
)

func itoa(n int) string { return strconv.Itoa(n) }

func ioReadFull(r io.Reader, b []byte) (int, error) { return io.ReadFull(r, b) }

func inspectOpts() client.ContainerInspectOptions { return client.ContainerInspectOptions{} }

func foreignCreate(name, image string, labels map[string]string) client.ContainerCreateOptions {
	return client.ContainerCreateOptions{Name: name, Config: &container.Config{Image: image, Cmd: []string{"true"}, Labels: labels}}
}
