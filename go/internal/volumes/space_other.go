//go:build !unix

package volumes

// diskSpace is not known here; imports skip the free space check.
func diskSpace(string) (free, total uint64, ok bool) { return 0, 0, false }
