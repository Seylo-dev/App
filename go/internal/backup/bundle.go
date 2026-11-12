package backup

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// A bundle is one object holding several dumps, one per chosen database
// (Postgres pg_dump --format=custom, MongoDB mongodump --archive --gzip),
// so a backup of several databases stays one object: retention, signing
// and deletion count and name objects, one per run. The dumps stream out
// of their tools with no size known in advance, so tar (sizes first) and
// zip (directory at the end) do not fit; the frame is:
//
//	"SEYLO-BUNDLE-1\n"
//	frame*: kind (1 byte), length (uint32, big endian), payload
//
// The first frame is 'M', the manifest (JSON bundleManifest). Then, for
// each member in manifest order, 'D' frames with its bytes and one 'E'
// frame (empty) at its end. A 'Z' frame (empty) ends the bundle: a bundle
// that stops before it was cut short and is refused.
const bundleMagic = "SEYLO-BUNDLE-1\n"

const (
	frameManifest = 'M'
	frameData     = 'D'
	frameEnd      = 'E'
	frameDone     = 'Z'
	// maxFrame bounds what one frame may claim, so a damaged length never
	// makes the reader allocate gigabytes.
	maxFrame = 4 << 20
	// maxManifest bounds the manifest's JSON.
	maxManifest = 1 << 20
	// dataFrame is how much of a member one 'D' frame carries at most.
	dataFrame = 1 << 20
)

// bundleManifest names the members of a bundle.
type bundleManifest struct {
	// Engine is "postgres" or "mongo".
	Engine  string         `json:"engine"`
	Members []bundleMember `json:"members"`
}

type bundleMember struct {
	Database string `json:"database"`
	// Format is the member's own object format (extPgCustom, extMongo).
	Format string `json:"format"`
}

// bundleWriter frames members into w.
type bundleWriter struct {
	w    *bufio.Writer
	m    bundleManifest
	next int
	open bool
}

func newBundleWriter(w io.Writer, m bundleManifest) (*bundleWriter, error) {
	if len(m.Members) == 0 {
		return nil, fmt.Errorf("%w: a bundle needs at least one member", ErrBadRequest)
	}
	b := &bundleWriter{w: bufio.NewWriterSize(w, 64<<10), m: m}
	manifest, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	if _, err := b.w.WriteString(bundleMagic); err != nil {
		return nil, err
	}
	if err := b.frame(frameManifest, manifest); err != nil {
		return nil, err
	}
	return b, nil
}

func (b *bundleWriter) frame(kind byte, payload []byte) error {
	var head [5]byte
	head[0] = kind
	binary.BigEndian.PutUint32(head[1:], uint32(len(payload)))
	if _, err := b.w.Write(head[:]); err != nil {
		return err
	}
	_, err := b.w.Write(payload)
	return err
}

// member starts the next member and returns the writer for its bytes;
// call endMember when the member's dump is complete.
func (b *bundleWriter) member() (io.Writer, error) {
	if b.open || b.next >= len(b.m.Members) {
		return nil, errors.New("bundle: no member left to start")
	}
	b.open = true
	return memberWriter{b}, nil
}

type memberWriter struct{ b *bundleWriter }

func (m memberWriter) Write(p []byte) (int, error) {
	n := 0
	for len(p) > 0 {
		chunk := p
		if len(chunk) > dataFrame {
			chunk = chunk[:dataFrame]
		}
		if err := m.b.frame(frameData, chunk); err != nil {
			return n, err
		}
		n += len(chunk)
		p = p[len(chunk):]
	}
	return n, nil
}

func (b *bundleWriter) endMember() error {
	if !b.open {
		return errors.New("bundle: no member is open")
	}
	b.open = false
	b.next++
	return b.frame(frameEnd, nil)
}

// close ends the bundle once every member was written.
func (b *bundleWriter) close() error {
	if b.open || b.next != len(b.m.Members) {
		return fmt.Errorf("bundle: %d of %d members written", b.next, len(b.m.Members))
	}
	if err := b.frame(frameDone, nil); err != nil {
		return err
	}
	return b.w.Flush()
}

// bundleReader reads a bundle member by member.
type bundleReader struct {
	r        *bufio.Reader
	manifest bundleManifest
	next     int
	// left is what remains of the current 'D' frame.
	left int
	// inMember: the current member's 'E' was not read yet.
	inMember bool
	done     bool
}

var errCutShort = fmt.Errorf("%w: the bundle is cut short", ErrBadArchive)

func openBundle(r io.Reader) (*bundleReader, error) {
	br := &bundleReader{r: bufio.NewReaderSize(r, 64<<10)}
	magic := make([]byte, len(bundleMagic))
	if _, err := io.ReadFull(br.r, magic); err != nil || string(magic) != bundleMagic {
		return nil, fmt.Errorf("%w: not a backup bundle", ErrBadArchive)
	}
	kind, n, err := br.head()
	if err != nil {
		return nil, err
	}
	if kind != frameManifest || n > maxManifest {
		return nil, fmt.Errorf("%w: the bundle has no manifest", ErrBadArchive)
	}
	raw := make([]byte, n)
	if _, err := io.ReadFull(br.r, raw); err != nil {
		return nil, errCutShort
	}
	if err := json.Unmarshal(raw, &br.manifest); err != nil || len(br.manifest.Members) == 0 {
		return nil, fmt.Errorf("%w: the bundle's manifest is not valid", ErrBadArchive)
	}
	for _, m := range br.manifest.Members {
		if m.Database == "" || (m.Format != extPgCustom && m.Format != extMongo) {
			return nil, fmt.Errorf("%w: the bundle's manifest names a member it cannot hold", ErrBadArchive)
		}
	}
	return br, nil
}

func (br *bundleReader) head() (byte, int, error) {
	var head [5]byte
	if _, err := io.ReadFull(br.r, head[:]); err != nil {
		return 0, 0, errCutShort
	}
	n := binary.BigEndian.Uint32(head[1:])
	if n > maxFrame {
		return 0, 0, fmt.Errorf("%w: a bundle frame claims %d bytes", ErrBadArchive, n)
	}
	return head[0], int(n), nil
}

// nextMember returns the next member and a reader of its bytes, which
// must be read to EOF (or drained with drain) before the next call.
// io.EOF after the last member, once the end frame was read.
func (br *bundleReader) nextMember() (bundleMember, io.Reader, error) {
	if br.inMember {
		return bundleMember{}, nil, errors.New("bundle: the previous member was not read to its end")
	}
	if br.next == len(br.manifest.Members) {
		if !br.done {
			kind, n, err := br.head()
			if err != nil {
				return bundleMember{}, nil, err
			}
			if kind != frameDone || n != 0 {
				return bundleMember{}, nil, fmt.Errorf("%w: the bundle holds more than its manifest names", ErrBadArchive)
			}
			br.done = true
		}
		return bundleMember{}, nil, io.EOF
	}
	m := br.manifest.Members[br.next]
	br.next++
	br.inMember = true
	return m, memberReader{br}, nil
}

type memberReader struct{ br *bundleReader }

func (m memberReader) Read(p []byte) (int, error) {
	br := m.br
	for br.left == 0 {
		if !br.inMember {
			return 0, io.EOF
		}
		kind, n, err := br.head()
		if err != nil {
			return 0, err
		}
		switch kind {
		case frameData:
			br.left = n
		case frameEnd:
			if n != 0 {
				return 0, fmt.Errorf("%w: a member's end frame has a payload", ErrBadArchive)
			}
			br.inMember = false
			return 0, io.EOF
		default:
			return 0, fmt.Errorf("%w: unexpected frame %q inside a member", ErrBadArchive, kind)
		}
	}
	if len(p) > br.left {
		p = p[:br.left]
	}
	n, err := br.r.Read(p)
	br.left -= n
	if err == io.EOF {
		// Only the end frame may end a member.
		return n, errCutShort
	}
	return n, err
}

// drain reads what a restore tool left of the current member.
func (br *bundleReader) drain() error {
	if !br.inMember && br.left == 0 {
		return nil
	}
	_, err := io.Copy(io.Discard, memberReader{br})
	return err
}
