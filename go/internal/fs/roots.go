package fs

import (
	"errors"
	"fmt"
	"os"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// ErrUnknownVolume means the service or volume is not in this node's
// desired state.
var ErrUnknownVolume = errors.New("fs: unknown service volume")

// VolumeRoots opens service volumes. Resolve maps a root to its folder on
// the node (services/<owner>/volumes/<name>) and returns ErrUnknownVolume
// for anything the desired state does not list.
type VolumeRoots struct {
	Resolve func(root *agentv1.FsRoot) (string, error)
}

var _ Roots = VolumeRoots{}

// Open implements Roots. A volume folder that does not exist yet (the
// service never started) is created empty.
func (v VolumeRoots) Open(root *agentv1.FsRoot) (FS, error) {
	dir, err := v.Resolve(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("creating volume folder: %w", err)
	}
	return OpenDir(dir)
}
