package agent

import (
	"encoding/binary"
	"syscall"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"
)

// macOS is only a development platform for the agent; these are best
// effort.

func osName() string {
	if v, err := syscall.Sysctl("kern.osproductversion"); err == nil && v != "" {
		return "macos " + v
	}
	return "macos"
}

func kernelRelease() string {
	v, _ := syscall.Sysctl("kern.osrelease")
	return v
}

func memoryTotal() uint64 {
	v, err := syscall.Sysctl("hw.memsize")
	if err != nil {
		return 0
	}
	b := []byte(v)
	// Sysctl trims a trailing zero byte; put it back.
	for len(b) < 8 {
		b = append(b, 0)
	}
	return binary.LittleEndian.Uint64(b[:8])
}

func bootTime() *timestamppb.Timestamp {
	v, err := syscall.Sysctl("kern.boottime")
	if err != nil || len(v) < 8 {
		return nil
	}
	b := []byte(v)
	for len(b) < 8 {
		b = append(b, 0)
	}
	return timestamppb.New(time.Unix(int64(binary.LittleEndian.Uint64(b[:8])), 0))
}
