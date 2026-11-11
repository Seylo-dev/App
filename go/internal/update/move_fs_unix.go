//go:build unix

package update

import (
	"os"
	"syscall"
)

// fileID is a folder's device and inode: a rename keeps it, so the agent
// can tell the folder it moved into place from one that was there before.
type fileID struct {
	Dev uint64 `json:"dev"`
	Ino uint64 `json:"ino"`
}

func idOf(path string) (fileID, bool) {
	info, err := os.Lstat(path)
	if err != nil {
		return fileID{}, false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fileID{}, false
	}
	return fileID{Dev: uint64(st.Dev), Ino: st.Ino}, true
}

// freeBytes is the space available to unprivileged writers under path.
func freeBytes(path string) (uint64, bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, false
	}
	return uint64(st.Bavail) * uint64(st.Bsize), true
}
