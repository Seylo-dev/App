//go:build !unix

package volumes

// DiskSpace is not known here; callers skip their free space checks.
func DiskSpace(string) (free, total uint64, ok bool) { return 0, 0, false }
