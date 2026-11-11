//go:build !unix

package update

type fileID struct {
	Dev uint64 `json:"dev"`
	Ino uint64 `json:"ino"`
}

func idOf(string) (fileID, bool) { return fileID{}, false }

func freeBytes(string) (uint64, bool) { return 0, false }
