//go:build unix

package volumes

import (
	"errors"
	"strings"
	"syscall"
)

// openNonblock keeps open(2) from blocking on a pipe swapped in for a file.
const openNonblock = syscall.O_NONBLOCK

// isEscapeOrLoop reports an os.Root refusal: a symlink that leaves the
// root (os has no exported error for it), a symlink loop, or a folder
// that is no longer one.
func isEscapeOrLoop(err error) bool {
	return errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.ENOTDIR) ||
		strings.Contains(err.Error(), "path escapes from parent")
}
