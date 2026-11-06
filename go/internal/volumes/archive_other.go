//go:build !unix

package volumes

import "strings"

const openNonblock = 0

func isEscapeOrLoop(err error) bool {
	return strings.Contains(err.Error(), "path escapes from parent")
}
