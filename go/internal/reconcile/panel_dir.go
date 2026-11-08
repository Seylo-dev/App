package reconcile

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/docker"
)

// panelDirMode keeps the panel's folder (master.key, panel.db, the agents'
// TLS key) to its owner: the panel user, and root.
const panelDirMode = 0o700

// panelDirOwner is who owned the panel's folder before preparePanelDir
// gave it to the panel user, so a failed first start under that user can
// give it back to the panel container that ran before.
type panelDirOwner struct {
	uid, gid int
	changed  bool
}

// preparePanelDir runs before a panel container is created: the folder
// and everything in it go to docker.PanelUID/PanelGID (an install from
// before 0.2.0-rc.2 has them as uid 1000, the image's old user, which is
// the default login user on most cloud images), the folder is 0700 and
// master.key 0600. Entries are changed through an os.Root, so a link in
// the folder is changed itself and never leads outside it. Without root
// (tests) the owner stays as it is and only the modes change.
func preparePanelDir(layout datadir.Layout) (panelDirOwner, error) {
	dir := filepath.Join(layout.Root(), "panel")
	if err := os.MkdirAll(dir, panelDirMode); err != nil {
		return panelDirOwner{}, fmt.Errorf("creating the panel folder: %w", err)
	}
	was := panelDirOwner{uid: -1, gid: -1}
	if info, err := os.Stat(dir); err == nil {
		if st, ok := info.Sys().(*syscall.Stat_t); ok {
			was.uid, was.gid = int(st.Uid), int(st.Gid)
		}
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return was, fmt.Errorf("opening the panel folder: %w", err)
	}
	defer root.Close()
	if os.Geteuid() == 0 {
		err := fs.WalkDir(root.FS(), ".", func(name string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			if st, ok := info.Sys().(*syscall.Stat_t); ok && int(st.Uid) == docker.PanelUID && int(st.Gid) == docker.PanelGID {
				return nil
			}
			return root.Lchown(name, docker.PanelUID, docker.PanelGID)
		})
		if err != nil {
			return was, fmt.Errorf("giving the panel folder to the panel user (%s): %w", docker.PanelUser, err)
		}
		was.changed = was.uid != docker.PanelUID || was.gid != docker.PanelGID
	}
	if err := root.Chmod(".", panelDirMode); err != nil {
		return was, fmt.Errorf("closing the panel folder to other users: %w", err)
	}
	if err := root.Chmod("master.key", 0o600); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return was, fmt.Errorf("closing master.key to other users: %w", err)
	}
	return was, nil
}

// revert gives the folder back to its owner before preparePanelDir, when
// the panel that ran as that owner starts again (a failed first start as
// the panel user). Best effort.
func (o panelDirOwner) revert(layout datadir.Layout) {
	if !o.changed || o.uid < 0 {
		return
	}
	root, err := os.OpenRoot(filepath.Join(layout.Root(), "panel"))
	if err != nil {
		return
	}
	defer root.Close()
	_ = fs.WalkDir(root.FS(), ".", func(name string, _ fs.DirEntry, err error) error {
		if err == nil {
			_ = root.Lchown(name, o.uid, o.gid)
		}
		return nil
	})
}
