package fs

import (
	"errors"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// ErrUnknownVolume means the service or volume is not in this node's
// desired state.
var ErrUnknownVolume = errors.New("fs: unknown service volume")

// VolumeRoots opens service volumes. Resolve maps a root to its folder on
// the node (services/<owner>/volumes/<name>) and returns ErrUnknownVolume
// for anything the desired state does not list. Resolve also creates a
// volume folder that does not exist yet (the service never started), with
// the modes the node's layout requires (datadir.MakeServiceVolume: the
// service folders private to root); Open itself never creates folders, so
// the file manager cannot leave services/ or services/<id>/ open to other
// accounts.
type VolumeRoots struct {
	Resolve func(root *agentv1.FsRoot) (string, error)
}

var _ Roots = VolumeRoots{}

// Open implements Roots.
func (v VolumeRoots) Open(root *agentv1.FsRoot) (FS, error) {
	dir, err := v.Resolve(root)
	if err != nil {
		return nil, err
	}
	return OpenDir(dir)
}
