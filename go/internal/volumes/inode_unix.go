//go:build unix

package volumes

import (
	"io/fs"
	"syscall"
)

type inodeKey struct{ dev, ino uint64 }

// inodeOf returns the inode of files with more than one link.
func inodeOf(info fs.FileInfo) (inodeKey, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || st.Nlink < 2 {
		return inodeKey{}, false
	}
	return inodeKey{uint64(st.Dev), uint64(st.Ino)}, true
}
