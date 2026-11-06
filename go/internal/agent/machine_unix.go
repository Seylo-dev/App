//go:build unix

package agent

import (
	"errors"
	"io/fs"
	"path/filepath"
	"syscall"
)

// diskUsage reports the file system holding dir (or its nearest existing
// parent, before the data dir exists).
func diskUsage(dir string) (total, free uint64) {
	for d := dir; ; d = filepath.Dir(d) {
		var st syscall.Statfs_t
		if err := syscall.Statfs(d, &st); err == nil {
			return uint64(st.Blocks) * uint64(st.Bsize), uint64(st.Bavail) * uint64(st.Bsize)
		}
		if parent := filepath.Dir(d); parent == d {
			return 0, 0
		}
	}
}

// fsUsage reads the file system holding path (or its nearest existing
// parent) the way df does: used counts blocks in use, avail what an
// unprivileged writer may still use, so used/(used+avail) is df's Use%.
func fsUsage(path string) (fsUse, error) {
	for d := path; ; d = filepath.Dir(d) {
		var st syscall.Statfs_t
		err := syscall.Statfs(d, &st)
		if err == nil {
			var fi syscall.Stat_t
			if err := syscall.Stat(d, &fi); err != nil {
				return fsUse{}, err
			}
			bsize := uint64(st.Bsize)
			return fsUse{
				path:  d,
				dev:   uint64(fi.Dev),
				used:  (uint64(st.Blocks) - uint64(st.Bfree)) * bsize,
				avail: uint64(st.Bavail) * bsize,
			}, nil
		}
		if parent := filepath.Dir(d); parent == d || !errors.Is(err, fs.ErrNotExist) {
			return fsUse{}, err
		}
	}
}
