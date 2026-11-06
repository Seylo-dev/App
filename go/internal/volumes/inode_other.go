//go:build !unix

package volumes

import "io/fs"

type inodeKey struct{ dev, ino uint64 }

func inodeOf(fs.FileInfo) (inodeKey, bool) { return inodeKey{}, false }
