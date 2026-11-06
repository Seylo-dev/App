package dockerapi

import (
	"encoding/binary"
	"fmt"
	"io"
)

// Stream ids in Docker's multiplexed output.
const (
	StreamStdin  byte = 0
	StreamStdout byte = 1
	StreamStderr byte = 2
	// StreamSystem marks errors the daemon writes into the stream.
	StreamSystem byte = 3
)

// maxFrame bounds one frame so a corrupt header cannot make us allocate
// gigabytes. Docker writes at most 32 KiB per frame in practice.
const maxFrame = 16 << 20

// FrameReader reads Docker's multiplexed stream format (8-byte header:
// stream id, 3 zero bytes, big endian payload size), used for container
// logs, attach and exec when there is no TTY.
type FrameReader struct {
	r   io.Reader
	hdr [8]byte
	buf []byte
}

// NewFrameReader wraps r.
func NewFrameReader(r io.Reader) *FrameReader { return &FrameReader{r: r} }

// Next returns the next frame. The payload is valid until the next call.
// It returns io.EOF at a clean end.
func (f *FrameReader) Next() (stream byte, payload []byte, err error) {
	if _, err := io.ReadFull(f.r, f.hdr[:]); err != nil {
		if err == io.ErrUnexpectedEOF {
			return 0, nil, fmt.Errorf("docker stream: truncated header")
		}
		return 0, nil, err
	}
	size := binary.BigEndian.Uint32(f.hdr[4:])
	if size > maxFrame {
		return 0, nil, fmt.Errorf("docker stream: frame of %d bytes", size)
	}
	if cap(f.buf) < int(size) {
		f.buf = make([]byte, size)
	}
	f.buf = f.buf[:size]
	if _, err := io.ReadFull(f.r, f.buf); err != nil {
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return 0, nil, fmt.Errorf("docker stream: truncated frame")
		}
		return 0, nil, err
	}
	return f.hdr[0], f.buf, nil
}

// Demux copies a multiplexed stream to stdout and stderr until EOF.
// Either writer may be nil to drop that stream.
func Demux(r io.Reader, stdout, stderr io.Writer) error {
	fr := NewFrameReader(r)
	for {
		s, p, err := fr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		var w io.Writer
		switch s {
		case StreamStdout:
			w = stdout
		case StreamStderr, StreamSystem:
			w = stderr
		}
		if w != nil {
			if _, err := w.Write(p); err != nil {
				return err
			}
		}
	}
}
