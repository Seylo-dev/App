package update

import (
	"os"
	"syscall"
)

// chownLike gives path the owner of like. The panel container runs as a
// non-root user, so files the agent (root) writes into its folder must
// belong to that user. Best effort: tests run without root.
func chownLike(path string, like os.FileInfo) {
	if st, ok := like.Sys().(*syscall.Stat_t); ok {
		_ = os.Lchown(path, int(st.Uid), int(st.Gid))
	}
}
