package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/volumes"
)

// requiredPanelFiles must arrive with every move: without them the moved
// panel would start with a new identity or a new agents' TLS key (it
// makes them when they are missing), and no node would accept it.
var requiredPanelFiles = []string{"panel.db", "master.key", "agent-tls.key"}

// neverMoved are files of the panel's data folder that belong to the
// server they are on, or to one moment, and must not arrive with a move.
var neverMoved = map[string]string{
	"tailnet.sock":  "the tailnet socket",
	"setup-token":   "the setup token",
	"join-token":    "the installer's join token",
	"telemetry-off": "the installer's telemetry switch",
	"ip-access-on":  "the IP access switch",
	// Only CommitMovedPanel writes it, on the target: one that came along
	// would end the moved panel's standby before the switch.
	commitMarker: "the switch marker of a moved panel",
}

// neverMovedSuffixes: a key rotation that did not finish (".new"), and
// database side files (the databases come as one consistent copy each).
var neverMovedSuffixes = []string{".new", "-wal", "-shm", "-journal"}

// sqliteHeader starts every SQLite database file.
var sqliteHeader = []byte("SQLite format 3\x00")

// panelFile is one manifest entry, checked.
type panelFile struct {
	Path   string `json:"path"`
	Size   uint64 `json:"size"`
	SHA256 string `json:"sha256"`
}

// importedPanel is written next to a staging folder once every file in it
// matched the manifest; StartMovedPanel takes only such a folder.
type importedPanel struct {
	MoveID string      `json:"moveId"`
	Files  []panelFile `json:"files"`
	// Received is the compressed bytes received.
	Received uint64    `json:"received"`
	At       time.Time `json:"at"`
}

// checkManifest validates the manifest and returns it by path with the
// total size of its files.
func checkManifest(entries []*agentv1.PanelDataFile) (map[string]panelFile, uint64, error) {
	if len(entries) == 0 {
		return nil, 0, invalidMove("the manifest is empty")
	}
	if len(entries) > maxManifestFiles {
		return nil, 0, invalidMove("the manifest lists %d files, more than %d", len(entries), maxManifestFiles)
	}
	files := make(map[string]panelFile, len(entries))
	var total uint64
	for _, e := range entries {
		p := e.GetPath()
		if p == "" || strings.HasPrefix(p, "/") || strings.ContainsRune(p, 0) || strings.Contains(p, "\\") || path.Clean(p) != p ||
			p == "." || p == ".." || strings.HasPrefix(p, "../") {
			return nil, 0, invalidMove("manifest path %q is not a clean relative path", p)
		}
		base := path.Base(p)
		if what, ok := neverMoved[p]; ok {
			return nil, 0, invalidMove("the manifest lists %s (%s), which stays on its server", p, what)
		}
		for _, s := range neverMovedSuffixes {
			if strings.HasSuffix(base, s) {
				return nil, 0, invalidMove("the manifest lists %s: database side files and unfinished key rotations never move", p)
			}
		}
		sum := e.GetSha256()
		if b, err := hex.DecodeString(sum); err != nil || len(b) != sha256.Size || strings.ToLower(sum) != sum {
			return nil, 0, invalidMove("manifest entry %s: sha256 must be 64 lower-case hex digits", p)
		}
		if _, dup := files[p]; dup {
			return nil, 0, invalidMove("the manifest lists %s twice", p)
		}
		files[p] = panelFile{Path: p, Size: e.GetSize(), SHA256: sum}
		total += e.GetSize()
	}
	for _, name := range requiredPanelFiles {
		if _, ok := files[name]; !ok {
			return nil, 0, invalidMove("the manifest has no %s: the moved panel would not be the same panel", name)
		}
	}
	return files, total, nil
}

func manifestError(format string, args ...any) *MoveError {
	return moveErr(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, ReasonManifest, format, args...)
}

// archiveError maps an unpack failure to the answer. A cancelled import
// (an abort, the stream gone) says so, whatever the unpack made of the
// read that failed.
func archiveError(ctx context.Context, what string, err error) *MoveError {
	if me := (*MoveError)(nil); errors.As(err, &me) {
		return me
	}
	if cerr := ctx.Err(); cerr != nil {
		return failedMove(ReasonCancelled, fmt.Errorf("%s: %w", what, cerr))
	}
	switch {
	case errors.Is(err, volumes.ErrBadArchive):
		return moveErr(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, ReasonBadArchive, "%s: %v", what, err)
	case errors.Is(err, volumes.ErrTooLarge):
		return moveErr(agentv1.StatusCode_STATUS_CODE_RESOURCE_EXHAUSTED, ReasonNoSpace, "%s: %v", what, err)
	}
	return failedMove(ReasonBadArchive, fmt.Errorf("%s: %w", what, err))
}

// checkFree refuses when path's filesystem has less than need free.
func (m *PanelMover) checkFree(path string, need uint64) error {
	free, ok := m.opts.Free(path)
	if ok && free < need {
		return moveErr(agentv1.StatusCode_STATUS_CODE_RESOURCE_EXHAUSTED, ReasonNoSpace,
			"this node has %d MiB free in %s, the move needs %d MiB", free>>20, path, (need+(1<<20)-1)>>20)
	}
	return nil
}

// stagingParent makes <root>/<name> (0700, root only: it holds the
// panel's keys while a move runs) and deletes what other moves left in
// it: one node belongs to one panel, and a panel moves once at a time.
func (m *PanelMover) stagingParent(name, keep string) (string, error) {
	dir := filepath.Join(m.root(), name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		id := strings.TrimSuffix(e.Name(), ".json")
		if id == keep {
			continue
		}
		if err := secureRemoveAll(filepath.Join(dir, e.Name())); err != nil {
			return "", fmt.Errorf("deleting what an earlier move left in %s: %w", dir, err)
		}
	}
	return dir, nil
}

// freshDir replaces dir with an empty folder (an earlier staging of the
// same move goes).
func freshDir(dir string) error {
	if err := secureRemoveAll(dir); err != nil {
		return err
	}
	return os.Mkdir(dir, 0o700)
}

// countingReader counts the bytes read through it and stops once ctx
// ends (AbortMovedPanel cancels an import in the middle of a file).
type countingReader struct {
	ctx context.Context
	r   io.Reader
	n   uint64
}

func (c *countingReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := c.r.Read(p)
	c.n += uint64(n)
	return n, err
}

// ImportPanelData unpacks the panel's data folder from r into
// <root>/panel-incoming/<move> and checks it against the manifest: every
// listed file, with its size and SHA-256, and nothing else. A staging
// that does not match is deleted.
func (m *PanelMover) ImportPanelData(ctx context.Context, req *agentv1.ImportPanelDataRequest, r io.Reader) (*agentv1.ImportPanelDataResponse, error) {
	id := req.GetMoveId()
	if err := checkMoveID(id); err != nil {
		return nil, err
	}
	files, total, err := checkManifest(req.GetManifest())
	if err != nil {
		return nil, err
	}
	release, ok := m.lock.TryAcquire(holdPanelMove)
	if !ok {
		return nil, busyMove(m.lock.Holder())
	}
	defer release()
	ctx, end := m.beginStep(ctx, id)
	defer end()
	if err := m.refuseRunningPanel(ctx); err != nil {
		return nil, err
	}
	if err := m.settleOtherMove(ctx, id); err != nil {
		return nil, err
	}
	if err := m.checkFree(m.root(), max(req.GetSizeBytes()*3, total)+moveReserve); err != nil {
		return nil, err
	}
	if _, err := m.stagingParent(panelIncoming, id); err != nil {
		return nil, failedMove(ReasonBadArchive, err)
	}
	dir := m.incoming(id)
	_ = removeIfExists(m.incomingRecord(id))
	if err := freshDir(dir); err != nil {
		return nil, failedMove(ReasonBadArchive, fmt.Errorf("preparing %s: %w", dir, err))
	}
	in := &countingReader{ctx: ctx, r: r}
	res, err := m.unpackPanelData(ctx, dir, in, files, total)
	if err != nil {
		if rmErr := secureRemoveAll(dir); rmErr != nil {
			m.opts.Logger.Error("panel move: deleting a staging that did not match", "dir", dir, "err", rmErr)
		}
		return nil, err
	}
	res.Received = in.n
	res.At = m.opts.Now().UTC()
	if err := writeJSON(m.incomingRecord(id), res); err != nil {
		_ = secureRemoveAll(dir)
		return nil, failedMove(ReasonBadArchive, err)
	}
	m.opts.Logger.Info("panel move: the panel's data arrived and matches its manifest", "move_id", id, "files", len(files), "bytes", total)
	return &agentv1.ImportPanelDataResponse{SizeBytes: in.n, Files: uint32(len(files))}, nil
}

func (m *PanelMover) unpackPanelData(ctx context.Context, dir string, r io.Reader, files map[string]panelFile, total uint64) (*importedPanel, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, failedMove(ReasonBadArchive, err)
	}
	defer root.Close()
	seen := make(map[string]bool, len(files))
	_, err = volumes.Unpack(ctx, root, r, volumes.UnpackOptions{
		RegularOnly: true,
		Private:     true,
		CheckEnd:    true,
		Budget:      total,
		File: func(name string, size int64) error {
			f, ok := files[name]
			switch {
			case !ok:
				return manifestError("%s is in the archive but not in the manifest", name)
			case seen[name]:
				return manifestError("%s is in the archive twice", name)
			case uint64(size) != f.Size:
				return manifestError("%s is %d bytes in the archive, the manifest says %d", name, size, f.Size)
			}
			seen[name] = true
			return nil
		},
		Written: func(name string, size int64, sum [sha256.Size]byte) error {
			f := files[name]
			if uint64(size) != f.Size || hex.EncodeToString(sum[:]) != f.SHA256 {
				return manifestError("%s does not match its SHA-256 in the manifest", name)
			}
			return nil
		},
	})
	if err != nil {
		return nil, archiveError(ctx, "unpacking the panel's data", err)
	}
	out := &importedPanel{MoveID: filepath.Base(dir)}
	for p, f := range files {
		if !seen[p] {
			return nil, manifestError("%s is in the manifest but not in the archive", p)
		}
		out.Files = append(out.Files, f)
	}
	for _, db := range []string{"panel.db", "metrics.db"} {
		if _, ok := files[db]; !ok {
			continue
		}
		if err := checkSQLite(root, db); err != nil {
			return nil, manifestError("%s: %v", db, err)
		}
	}
	return out, nil
}

// checkSQLite makes sure name starts like an SQLite database.
func checkSQLite(root *os.Root, name string) error {
	f, err := root.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	head := make([]byte, len(sqliteHeader))
	if _, err := io.ReadFull(f, head); err != nil || !bytes.Equal(head, sqliteHeader) {
		return errors.New("not an SQLite database")
	}
	return nil
}

// readImported returns the record of a verified staging of move id and
// checks the folder still holds exactly those files.
func (m *PanelMover) readImported(id string) (*importedPanel, error) {
	var rec importedPanel
	if err := readJSON(m.incomingRecord(id), &rec); err != nil || rec.MoveID != id {
		return nil, refusedMove(ReasonNotImported, "the panel's data for move %s was not imported on this node", id)
	}
	root, err := os.OpenRoot(m.incoming(id))
	if err != nil {
		return nil, refusedMove(ReasonNotImported, "the panel's data for move %s is not on this node: %v", id, err)
	}
	defer root.Close()
	want := make(map[string]uint64, len(rec.Files))
	for _, f := range rec.Files {
		want[f.Path] = f.Size
	}
	found := 0
	err = fs.WalkDir(root.FS(), ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		size, ok := want[name]
		info, ierr := d.Info()
		if !ok || !d.Type().IsRegular() || ierr != nil || uint64(info.Size()) != size {
			return fmt.Errorf("%s changed since the import", name)
		}
		found++
		return nil
	})
	if err == nil && found != len(want) {
		err = errors.New("files are missing since the import")
	}
	if err != nil {
		return nil, refusedMove(ReasonNotImported, "the staged panel data for move %s: %v", id, err)
	}
	return &rec, nil
}

// removeStrayDBFiles deletes database side files the manifest does not
// list (none should be there: the folder was staged empty), so SQLite
// never replays an old WAL into the moved database.
func removeStrayDBFiles(dir string, rec *importedPanel) error {
	listed := map[string]bool{}
	for _, f := range rec.Files {
		listed[f.Path] = true
	}
	for _, db := range []string{"panel.db", "metrics.db"} {
		for _, side := range []string{"-wal", "-shm", "-journal"} {
			if name := db + side; !listed[name] {
				if err := removeIfExists(filepath.Join(dir, name)); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// ExportRegistry writes this node's image registry storage to w as
// .tar.gz and returns the file bytes archived; with no storage, an empty
// archive and 0. The panel refuses builds while it moves, so nothing
// pushes meanwhile.
func (m *PanelMover) ExportRegistry(ctx context.Context, req *agentv1.ExportRegistryRequest, w io.Writer) (*agentv1.ExportRegistryResponse, error) {
	if err := checkMoveID(req.GetMoveId()); err != nil {
		return nil, err
	}
	dir := m.registryDir()
	if !isDir(dir) {
		if err := emptyArchive(w); err != nil {
			return nil, failedMove(ReasonBadArchive, err)
		}
		return &agentv1.ExportRegistryResponse{}, nil
	}
	n, err := volumes.WriteArchive(ctx, dir, w, volumes.ArchiveOptions{Level: gzip.BestSpeed, HardLinks: true})
	if err != nil {
		return nil, failedMove(ReasonBadArchive, fmt.Errorf("archiving the registry storage: %w", err))
	}
	return &agentv1.ExportRegistryResponse{SizeBytes: n}, nil
}

func emptyArchive(w io.Writer) error {
	gz := gzip.NewWriter(w)
	if err := tar.NewWriter(gz).Close(); err != nil {
		return err
	}
	return gz.Close()
}

// ImportRegistry unpacks ExportRegistry's stream into
// <root>/registry-incoming/<move>; StartMovedPanel moves it into place.
func (m *PanelMover) ImportRegistry(ctx context.Context, req *agentv1.ImportRegistryRequest, r io.Reader) (*agentv1.ImportRegistryResponse, error) {
	id := req.GetMoveId()
	if err := checkMoveID(id); err != nil {
		return nil, err
	}
	release, ok := m.lock.TryAcquire(holdPanelMove)
	if !ok {
		return nil, busyMove(m.lock.Holder())
	}
	defer release()
	ctx, end := m.beginStep(ctx, id)
	defer end()
	if err := m.refuseRunningPanel(ctx); err != nil {
		return nil, err
	}
	if err := m.settleOtherMove(ctx, id); err != nil {
		return nil, err
	}
	if n := req.GetSizeBytes(); n > 0 {
		if err := m.checkFree(m.root(), n*3+moveReserve); err != nil {
			return nil, err
		}
	}
	// The size is a guess (or unknown): the unpack itself stops short of
	// the reserve, so a registry larger than the disk never fills it.
	var budget uint64
	if free, ok := m.opts.Free(m.root()); ok {
		if free <= moveReserve {
			return nil, m.checkFree(m.root(), moveReserve+1)
		}
		budget = free - moveReserve
	}
	if _, err := m.stagingParent(registryIncoming, id); err != nil {
		return nil, failedMove(ReasonBadArchive, err)
	}
	dir := m.registryIncoming(id)
	if err := freshDir(dir); err != nil {
		return nil, failedMove(ReasonBadArchive, fmt.Errorf("preparing %s: %w", dir, err))
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, failedMove(ReasonBadArchive, err)
	}
	n, err := volumes.Unpack(ctx, root, &countingReader{ctx: ctx, r: r}, volumes.UnpackOptions{Owners: os.Geteuid() == 0, Budget: budget, CheckEnd: true})
	root.Close()
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, archiveError(ctx, "unpacking the registry storage", err)
	}
	m.opts.Logger.Info("panel move: the registry storage arrived", "move_id", id, "bytes", n)
	return &agentv1.ImportRegistryResponse{SizeBytes: n}, nil
}
