//go:build linux || darwin

package metrics

import "syscall"

// statfs reports used and total bytes like df: total is all blocks, used
// is total minus free blocks.
func statfs(path string) (used, total uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	bs := uint64(st.Bsize)
	total = uint64(st.Blocks) * bs
	free := uint64(st.Bfree) * bs
	if free > total {
		free = total
	}
	return total - free, total, nil
}
