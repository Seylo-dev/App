//go:build unix

package volumes

import "syscall"

// DiskSpace is the space available to unprivileged writers under dir and
// the size of its filesystem; ok is false when they cannot be read.
func DiskSpace(dir string) (free, total uint64, ok bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, 0, false
	}
	return uint64(st.Bavail) * uint64(st.Bsize), uint64(st.Blocks) * uint64(st.Bsize), true
}
