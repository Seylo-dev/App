package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
)

const testMove = "mv00000000000001"

// sqliteFile is a panel.db that starts like an SQLite database.
func sqliteFile(body string) string { return "SQLite format 3\x00" + body }

// panelData is the panel's data folder a move ships in the tests.
func panelData() map[string]string {
	return map[string]string{
		"panel.db":          sqliteFile("moved panel"),
		"metrics.db":        sqliteFile("moved metrics"),
		"master.key":        "moved master key",
		"agent-tls.key":     "moved agents' TLS key",
		"agent-tls.crt":     "certificate",
		"branding/favicon":  "icon",
		"uploads/u1.tar.gz": "source upload",
	}
}

// tarEntry is one archive entry; files are regular files unless hdr says.
type tarEntry struct {
	hdr  tar.Header
	body string
}

func tarGz(t *testing.T, entries ...tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		h := e.hdr
		if h.Typeflag == 0 {
			h.Typeflag = tar.TypeReg
		}
		if h.Typeflag == tar.TypeReg {
			h.Size = int64(len(e.body))
		}
		if h.Mode == 0 {
			h.Mode = 0o644
		}
		if err := tw.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// dataArchive is files as a .tar.gz (sorted, folders first like the
// panel's sender) and its manifest.
func dataArchive(t *testing.T, files map[string]string) ([]byte, []*agentv1.PanelDataFile) {
	t.Helper()
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	var entries []tarEntry
	dirs := map[string]bool{}
	var manifest []*agentv1.PanelDataFile
	for _, n := range names {
		if d := filepath.Dir(n); d != "." && !dirs[d] {
			dirs[d] = true
			entries = append(entries, tarEntry{hdr: tar.Header{Name: d + "/", Typeflag: tar.TypeDir, Mode: 0o755}})
		}
		entries = append(entries, tarEntry{hdr: tar.Header{Name: n, Mode: 0o644}, body: files[n]})
		sum := sha256.Sum256([]byte(files[n]))
		manifest = append(manifest, &agentv1.PanelDataFile{Path: n, Size: uint64(len(files[n])), Sha256: hex.EncodeToString(sum[:])})
	}
	return tarGz(t, entries...), manifest
}

// moveFake is a node for a move: reconcile's desired state and statuses
// (fakeReconcile) and the panel containers they make.
type moveFake struct {
	rec *fakeReconcile

	mu         sync.Mutex
	containers map[string]*PanelContainer
	removed    []string
	regStops   int
	regRemoved int
	failRemove error
	listErr    error
}

func newMoveFake() *moveFake {
	f := &moveFake{
		rec:        &fakeReconcile{desired: &agentv1.DesiredState{Revision: 4}, status: map[string]*agentv1.ServiceStatus{}},
		containers: map[string]*PanelContainer{},
	}
	f.rec.onApply = func(spec *agentv1.ServiceSpec) {
		if spec.GetId() != defaultPanelServiceID {
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		name := "seylo-panel-" + strconv.FormatUint(spec.GetGeneration(), 10)
		for _, c := range f.containers {
			c.Running = false
		}
		f.containers[name] = &PanelContainer{ID: name, Name: name, Running: !spec.GetStopped()}
	}
	return f
}

func (f *moveFake) host() MoveHost {
	return MoveHost{
		PanelContainers: func(context.Context) ([]PanelContainer, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.listErr != nil {
				return nil, f.listErr
			}
			var out []PanelContainer
			for _, c := range f.containers {
				out = append(out, *c)
			}
			sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
			return out, nil
		},
		StopContainer: func(_ context.Context, id string) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			if c := f.containers[id]; c != nil {
				c.Running = false
			}
			return nil
		},
		RemoveContainer: func(_ context.Context, id string) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.failRemove != nil {
				return f.failRemove
			}
			delete(f.containers, id)
			f.removed = append(f.removed, id)
			return nil
		},
		StopRegistry: func(context.Context) error {
			f.mu.Lock()
			f.regStops++
			f.mu.Unlock()
			return nil
		},
		RemoveRegistry: func(context.Context) error {
			f.mu.Lock()
			f.regRemoved++
			f.mu.Unlock()
			return nil
		},
	}
}

// addContainer adds a panel container (a panel that runs here, or a
// stopped copy an earlier move left).
func (f *moveFake) addContainer(name string, running bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.containers[name] = &PanelContainer{ID: name, Name: name, Running: running}
}

func (f *moveFake) running() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.containers {
		if c.Running {
			out = append(out, c.Name)
		}
	}
	return out
}

func (f *moveFake) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.containers)
}

func (f *moveFake) panelSpec() *agentv1.ServiceSpec {
	f.rec.mu.Lock()
	defer f.rec.mu.Unlock()
	return findSpec(f.rec.desired, defaultPanelServiceID)
}

// movedPanel is the moved panel answering on 127.0.0.1: the agents' TLS
// port (an httptest TLS server, its key is the pin) and /api/health, with
// the move id it names while it waits for the switch.
type movedPanel struct {
	tls, http *httptest.Server
	pin       string
	version   string
}

func startMovedPanel(t *testing.T, version string) *movedPanel {
	t.Helper()
	p := &movedPanel{version: version}
	p.tls = httptest.NewTLSServer(http.NotFoundHandler())
	t.Cleanup(p.tls.Close)
	p.pin = conn.FormatPin(conn.SPKIFingerprint(p.tls.Certificate()))
	p.http = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "version": p.version, "moveId": testMove})
	}))
	t.Cleanup(p.http.Close)
	return p
}

func port(t *testing.T, srv *httptest.Server) uint32 {
	t.Helper()
	_, p, err := net.SplitHostPort(srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	n, _ := strconv.Atoi(p)
	return uint32(n)
}

type moveFixture struct {
	m    *PanelMover
	f    *moveFake
	root string
	free uint64
	url  string
	lock *Lock
}

func newMoveFixture(t *testing.T) *moveFixture {
	t.Helper()
	savedWait, savedPoll, savedDelay, savedRetry := moveCheckWait, moveCheckPoll, retireDelay, retryRetire
	t.Cleanup(func() {
		moveCheckWait, moveCheckPoll, retireDelay, retryRetire = savedWait, savedPoll, savedDelay, savedRetry
	})
	moveCheckWait, moveCheckPoll, retireDelay, retryRetire = 2*time.Second, 10*time.Millisecond, 0, 10*time.Millisecond
	fx := &moveFixture{f: newMoveFake(), root: t.TempDir(), free: 1 << 40, lock: &Lock{}}
	fx.m = NewPanelMover(MoveOptions{
		DataDir:  fx.root,
		Runtime:  fx.f.rec.runtime(),
		Host:     fx.f.host(),
		PanelURL: func() string { return fx.url },
		Free:     func(string) (uint64, bool) { return fx.free, true },
	}, fx.lock)
	return fx
}

func (fx *moveFixture) path(parts ...string) string {
	return filepath.Join(append([]string{fx.root}, parts...)...)
}

func (fx *moveFixture) importData(t *testing.T, id string, files map[string]string) (*agentv1.ImportPanelDataResponse, error) {
	t.Helper()
	data, manifest := dataArchive(t, files)
	return fx.m.ImportPanelData(context.Background(), &agentv1.ImportPanelDataRequest{MoveId: id, SizeBytes: uint64(len(data)), Manifest: manifest}, bytes.NewReader(data))
}

func (fx *moveFixture) startRequest(t *testing.T, p *movedPanel) *agentv1.StartMovedPanelRequest {
	return &agentv1.StartMovedPanelRequest{
		MoveId: testMove,
		Spec: &agentv1.ServiceSpec{Id: defaultPanelServiceID, Name: "panel", ProjectId: "panelproject0000", Protected: true, Generation: 7,
			Image: &agentv1.ImageRef{Reference: "ghcr.io/x/panel:0.2.8", Digest: "sha256:abc"}},
		PanelPin:        p.pin,
		AgentTlsPort:    port(t, p.tls),
		HostPort:        port(t, p.http),
		ExpectedVersion: "0.2.8",
		HealthTimeout:   durationpb.New(time.Second),
	}
}

func mustWriteFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func reasonOf(err error) string {
	var me *MoveError
	if errors.As(err, &me) {
		return me.Reason
	}
	return ""
}

func codeOf(err error) agentv1.StatusCode {
	var me *MoveError
	if errors.As(err, &me) {
		return me.Code
	}
	return agentv1.StatusCode_STATUS_CODE_UNSPECIFIED
}

func gone(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("%s still exists (%v)", path, err)
	}
}

func TestImportPanelDataStagesAndChecksTheManifest(t *testing.T) {
	fx := newMoveFixture(t)
	files := panelData()
	res, err := fx.importData(t, testMove, files)
	if err != nil {
		t.Fatal(err)
	}
	if res.GetFiles() != uint32(len(files)) || res.GetSizeBytes() == 0 {
		t.Fatalf("response = %v", res)
	}
	dir := fx.path(panelIncoming, testMove)
	for name, body := range files {
		if got := readFile(t, filepath.Join(dir, name)); got != body {
			t.Errorf("%s = %q", name, got)
		}
		info, _ := os.Stat(filepath.Join(dir, name))
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s mode %o, want 0600", name, info.Mode().Perm())
		}
	}
	for _, d := range []string{fx.path(panelIncoming), dir, filepath.Join(dir, "branding")} {
		if info, err := os.Stat(d); err != nil || info.Mode().Perm() != 0o700 {
			t.Errorf("%s: %v mode %v, want 0700", d, err, info.Mode().Perm())
		}
	}
	if !exists(fx.path(panelIncoming, testMove+".json")) {
		t.Fatal("no import record")
	}
	// The live folder is never touched by an import.
	gone(t, fx.path("panel"))
	// Importing the same move again replaces the staging.
	files["branding/logo"] = "logo"
	delete(files, "uploads/u1.tar.gz")
	if _, err := fx.importData(t, testMove, files); err != nil {
		t.Fatal(err)
	}
	gone(t, filepath.Join(dir, "uploads", "u1.tar.gz"))
	// A staging another move left goes with a new import.
	if _, err := fx.importData(t, "mv00000000000002", files); err != nil {
		t.Fatal(err)
	}
	gone(t, dir)
	gone(t, fx.path(panelIncoming, testMove+".json"))
}

func TestImportPanelDataRefusesAMismatch(t *testing.T) {
	good := panelData()
	data, manifest := dataArchive(t, good)
	plain := panelData()
	plain["panel.db"] = "plain text"
	notSQLite, notSQLiteManifest := dataArchive(t, plain)
	base := t.TempDir()
	outside := filepath.Join(base, "outside")
	cases := map[string]struct {
		archive  []byte
		manifest []*agentv1.PanelDataFile
	}{
		"extra file": {archive: func() []byte {
			files := panelData()
			files["extra"] = "x"
			a, _ := dataArchive(t, files)
			return a
		}(), manifest: manifest},
		"missing file": {archive: func() []byte {
			files := panelData()
			delete(files, "branding/favicon")
			a, _ := dataArchive(t, files)
			return a
		}(), manifest: manifest},
		"changed content": {archive: func() []byte {
			files := panelData()
			files["master.key"] = "another key"
			a, _ := dataArchive(t, files)
			return a
		}(), manifest: manifest},
		"same size, other bytes": {archive: func() []byte {
			files := panelData()
			files["master.key"] = strings.Repeat("x", len(good["master.key"]))
			a, _ := dataArchive(t, files)
			return a
		}(), manifest: manifest},
		"symlink":   {archive: tarGz(t, tarEntry{hdr: tar.Header{Name: "master.key", Typeflag: tar.TypeSymlink, Linkname: "/etc/shadow"}}), manifest: manifest},
		"hard link": {archive: tarGz(t, tarEntry{hdr: tar.Header{Name: "panel.db", Typeflag: tar.TypeLink, Linkname: "../../outside/x"}}), manifest: manifest},
		"dot-dot":   {archive: tarGz(t, tarEntry{hdr: tar.Header{Name: "../../outside/x"}, body: "pwn"}), manifest: manifest},
		"absolute":  {archive: tarGz(t, tarEntry{hdr: tar.Header{Name: filepath.Join(outside, "x")}, body: "pwn"}), manifest: manifest},
		"truncated": {archive: data[:len(data)/2], manifest: manifest},
		"garbage":   {archive: []byte("not gzip"), manifest: manifest},
		"trailing data": {archive: func() []byte {
			var buf bytes.Buffer
			buf.Write(data)
			gz := gzip.NewWriter(&buf)
			_, _ = gz.Write([]byte("more"))
			_ = gz.Close()
			return buf.Bytes()
		}(), manifest: manifest},
		"not sqlite": {archive: notSQLite, manifest: notSQLiteManifest},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if err := os.MkdirAll(outside, 0o755); err != nil {
				t.Fatal(err)
			}
			fx := newMoveFixture(t)
			_, err := fx.m.ImportPanelData(context.Background(), &agentv1.ImportPanelDataRequest{MoveId: testMove, Manifest: tc.manifest}, bytes.NewReader(tc.archive))
			if err == nil {
				t.Fatal("accepted")
			}
			if r := reasonOf(err); r != ReasonManifest && r != ReasonBadArchive {
				t.Fatalf("reason %q (%v)", r, err)
			}
			if codeOf(err) != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT {
				t.Fatalf("code %v (%v)", codeOf(err), err)
			}
			gone(t, fx.path(panelIncoming, testMove))
			gone(t, fx.path(panelIncoming, testMove+".json"))
			gone(t, filepath.Join(outside, "x"))
		})
	}
}

func TestImportPanelDataManifestRules(t *testing.T) {
	sum := strings.Repeat("ab", 32)
	entry := func(p string) *agentv1.PanelDataFile { return &agentv1.PanelDataFile{Path: p, Size: 1, Sha256: sum} }
	required := []*agentv1.PanelDataFile{entry("panel.db"), entry("master.key"), entry("agent-tls.key")}
	for name, extra := range map[string][]*agentv1.PanelDataFile{
		"wal":              {entry("panel.db-wal")},
		"shm":              {entry("metrics.db-shm")},
		"rotation":         {entry("master.key.new")},
		"tls rotation":     {entry("agent-tls.key.new")},
		"setup token":      {entry("setup-token")},
		"join token":       {entry("join-token")},
		"tailnet socket":   {entry("tailnet.sock")},
		"telemetry switch": {entry("telemetry-off")},
		"ip access switch": {entry("ip-access-on")},
		"unclean":          {entry("branding/../x")},
		"dot slash":        {entry("./x")},
		"absolute":         {entry("/etc/passwd")},
		"dot-dot":          {entry("../x")},
		"duplicate":        {entry("panel.db")},
		"bad sum":          {{Path: "x", Size: 1, Sha256: "nothex"}},
		"upper-case sum":   {{Path: "x", Size: 1, Sha256: strings.ToUpper(sum)}},
	} {
		if _, _, err := checkManifest(append(append([]*agentv1.PanelDataFile{}, required...), extra...)); err == nil || reasonOf(err) != ReasonBadRequest {
			t.Errorf("%s: %v", name, err)
		}
	}
	for _, missing := range []string{"panel.db", "master.key", "agent-tls.key"} {
		var m []*agentv1.PanelDataFile
		for _, e := range required {
			if e.GetPath() != missing {
				m = append(m, e)
			}
		}
		if _, _, err := checkManifest(m); err == nil || !strings.Contains(err.Error(), missing) {
			t.Errorf("without %s: %v", missing, err)
		}
	}
	if _, total, err := checkManifest(append(required, entry("branding/favicon"))); err != nil || total != 4 {
		t.Fatalf("a good manifest: %d, %v", total, err)
	}
}

func TestImportPanelDataRefusals(t *testing.T) {
	t.Run("free space", func(t *testing.T) {
		fx := newMoveFixture(t)
		fx.free = 10 << 20
		_, err := fx.importData(t, testMove, panelData())
		if reasonOf(err) != ReasonNoSpace || codeOf(err) != agentv1.StatusCode_STATUS_CODE_RESOURCE_EXHAUSTED {
			t.Fatalf("err = %v", err)
		}
		gone(t, fx.path(panelIncoming, testMove))
	})
	t.Run("a panel runs here", func(t *testing.T) {
		fx := newMoveFixture(t)
		fx.f.addContainer("seylo-panel-3", true)
		_, err := fx.importData(t, testMove, panelData())
		if reasonOf(err) != ReasonPanelRunning || codeOf(err) != agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("docker does not answer", func(t *testing.T) {
		fx := newMoveFixture(t)
		fx.f.listErr = errors.New("docker is down")
		if _, err := fx.importData(t, testMove, panelData()); err == nil {
			t.Fatal("imported without knowing whether a panel runs")
		}
	})
	t.Run("busy", func(t *testing.T) {
		fx := newMoveFixture(t)
		release, _ := fx.lock.TryAcquire(holdAgentUpdate)
		defer release()
		_, err := fx.importData(t, testMove, panelData())
		if reasonOf(err) != ReasonBusy || codeOf(err) != agentv1.StatusCode_STATUS_CODE_ABORTED {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("bad move id", func(t *testing.T) {
		fx := newMoveFixture(t)
		if _, err := fx.importData(t, "../etc", panelData()); reasonOf(err) != ReasonBadRequest {
			t.Fatalf("err = %v", err)
		}
	})
}

// An abort during an upload stops it and deletes what arrived.
func TestAbortStopsAnImportInFlight(t *testing.T) {
	fx := newMoveFixture(t)
	files := panelData()
	files["uploads/big.tar.gz"] = strings.Repeat("payload ", 64<<10)
	data, manifest := dataArchive(t, files)
	pr, pw := io.Pipe()
	t.Cleanup(func() { _ = pr.CloseWithError(errors.New("test over")) })
	done := make(chan error, 1)
	go func() {
		_, err := fx.m.ImportPanelData(context.Background(), &agentv1.ImportPanelDataRequest{MoveId: testMove, Manifest: manifest}, pr)
		done <- err
	}()
	if _, err := pw.Write(data[:len(data)/4]); err != nil {
		t.Fatal(err)
	}
	aborted := make(chan error, 1)
	go func() { aborted <- fx.m.Abort(context.Background(), &agentv1.AbortMovedPanelRequest{MoveId: testMove}) }()
	go func() {
		// The sender goes on until the import stops reading.
		for rest := data[len(data)/4:]; len(rest) > 0; rest = rest[min(512, len(rest)):] {
			if _, err := pw.Write(rest[:min(512, len(rest))]); err != nil {
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	select {
	case err := <-done:
		if reasonOf(err) != ReasonCancelled || codeOf(err) != agentv1.StatusCode_STATUS_CODE_CANCELLED {
			t.Fatalf("import = %v (%s), want cancelled", err, reasonOf(err))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the import kept going after the abort")
	}
	if err := <-aborted; err != nil {
		t.Fatal(err)
	}
	gone(t, fx.path(panelIncoming, testMove))
	gone(t, fx.path(panelIncoming, testMove+".json"))
}

// prepareTarget gives the target an older panel folder and registry of
// its own (it ran the panel once), and stages the move's data and registry.
func prepareTarget(t *testing.T, fx *moveFixture) {
	t.Helper()
	mustWriteFile(t, fx.path("panel", "panel.db"), sqliteFile("old panel"))
	mustWriteFile(t, fx.path("panel", "panel.db-wal"), "old wal")
	mustWriteFile(t, fx.path("panel", "master.key"), "old key")
	mustWriteFile(t, fx.path("registry", "docker", "old-blob"), "old blob")
	if _, err := fx.importData(t, testMove, panelData()); err != nil {
		t.Fatal(err)
	}
	reg := tarGz(t, tarEntry{hdr: tar.Header{Name: "docker/", Typeflag: tar.TypeDir, Mode: 0o755}}, tarEntry{hdr: tar.Header{Name: "docker/new-blob"}, body: "new blob"})
	if _, err := fx.m.ImportRegistry(context.Background(), &agentv1.ImportRegistryRequest{MoveId: testMove, SizeBytes: uint64(len(reg))}, bytes.NewReader(reg)); err != nil {
		t.Fatal(err)
	}
}

// targetIsBack checks the target is as before the move: its own folders,
// no moved panel, nothing staged, no journal.
func targetIsBack(t *testing.T, fx *moveFixture) {
	t.Helper()
	if got := readFile(t, fx.path("panel", "panel.db")); got != sqliteFile("old panel") {
		t.Fatalf("panel.db = %q, want the old one back", got)
	}
	if got := readFile(t, fx.path("panel", "master.key")); got != "old key" {
		t.Fatalf("master.key = %q", got)
	}
	if got := readFile(t, fx.path("registry", "docker", "old-blob")); got != "old blob" {
		t.Fatalf("registry = %q", got)
	}
	gone(t, fx.path("registry", "docker", "new-blob"))
	gone(t, fx.path(panelBefore+testMove))
	gone(t, fx.path(registryBefore+testMove))
	gone(t, fx.path(panelIncoming, testMove))
	gone(t, fx.path(panelIncoming, testMove+".json"))
	gone(t, fx.path(registryIncoming, testMove))
	gone(t, fx.path("update", moveJournal))
	if spec := fx.f.panelSpec(); spec != nil {
		t.Fatalf("the desired state still has the panel: %v", spec)
	}
	if n := fx.f.count(); n != 0 {
		t.Fatalf("%d panel containers left", n)
	}
}

func TestStartMovedPanelThenAbort(t *testing.T) {
	fx := newMoveFixture(t)
	prepareTarget(t, fx)
	// A stopped copy an earlier move left here goes before the start.
	fx.f.addContainer("seylo-panel-2", false)
	p := startMovedPanel(t, "0.2.8")
	req := fx.startRequest(t, p)
	res, err := fx.m.Start(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if res.GetVersion() != "0.2.8" {
		t.Fatalf("version %q", res.GetVersion())
	}
	for name, body := range panelData() {
		if got := readFile(t, fx.path("panel", name)); got != body {
			t.Fatalf("live %s = %q", name, got)
		}
	}
	// The old WAL went with the old folder, never next to the moved database.
	gone(t, fx.path("panel", "panel.db-wal"))
	if got := readFile(t, fx.path(panelBefore+testMove, "panel.db-wal")); got != "old wal" {
		t.Fatalf("the folder set aside lost its WAL: %q", got)
	}
	if got := readFile(t, fx.path("registry", "docker", "new-blob")); got != "new blob" {
		t.Fatalf("registry = %q", got)
	}
	if got := readFile(t, fx.path(registryBefore+testMove, "docker", "old-blob")); got != "old blob" {
		t.Fatalf("registry aside = %q", got)
	}
	if info, _ := os.Stat(fx.path("panel")); info.Mode().Perm() != 0o700 {
		t.Fatalf("panel folder mode %o", info.Mode().Perm())
	}
	spec := fx.f.panelSpec()
	if spec == nil || spec.GetGeneration() != 7 || spec.GetStopped() || spec.GetImage().GetDigest() != "sha256:abc" {
		t.Fatalf("desired panel spec = %v; it must be exactly the moved panel's", spec)
	}
	if run := fx.f.running(); len(run) != 1 || run[0] != "seylo-panel-7" {
		t.Fatalf("running = %v", run)
	}
	if fx.f.removed[0] != "seylo-panel-2" {
		t.Fatalf("removed = %v, want the stopped leftover first", fx.f.removed)
	}
	var j panelMove
	if err := readJSON(fx.path("update", moveJournal), &j); err != nil || j.Phase != moveHealthy || j.Version != "0.2.8" {
		t.Fatalf("journal = %+v, %v", j, err)
	}
	// A retried call answers again.
	if res, err := fx.m.Start(context.Background(), req); err != nil || res.GetVersion() != "0.2.8" {
		t.Fatalf("retry = %v, %v", res, err)
	}
	// A second panel never starts next to the moved one.
	other := fx.startRequest(t, p)
	other.MoveId = "mv00000000000009"
	if _, err := fx.m.Start(context.Background(), other); reasonOf(err) != ReasonPanelRunning {
		t.Fatalf("another start = %v", err)
	}

	if err := fx.m.Abort(context.Background(), &agentv1.AbortMovedPanelRequest{MoveId: testMove}); err != nil {
		t.Fatal(err)
	}
	targetIsBack(t, fx)
	// Again: nothing to do.
	if err := fx.m.Abort(context.Background(), &agentv1.AbortMovedPanelRequest{MoveId: testMove}); err != nil {
		t.Fatal(err)
	}
	targetIsBack(t, fx)
}

func TestStartMovedPanelFailuresPutEverythingBack(t *testing.T) {
	for name, tc := range map[string]struct {
		change func(fx *moveFixture, p *movedPanel, req *agentv1.StartMovedPanelRequest)
		reason string
	}{
		"never healthy": {change: func(_ *moveFixture, _ *movedPanel, req *agentv1.StartMovedPanelRequest) {
			req.Spec.Image.Reference = "ghcr.io/x/bad-panel:0.2.8"
		}, reason: ReasonHealth},
		"another TLS key": {change: func(_ *moveFixture, _ *movedPanel, req *agentv1.StartMovedPanelRequest) {
			req.PanelPin = conn.FormatPin(make([]byte, 32))
		}, reason: ReasonPin},
		"TLS port closed": {change: func(_ *moveFixture, p *movedPanel, _ *agentv1.StartMovedPanelRequest) {
			p.tls.Close()
		}, reason: ReasonPin},
		"another version": {change: func(_ *moveFixture, p *movedPanel, _ *agentv1.StartMovedPanelRequest) {
			p.version = "0.2.7"
		}, reason: ReasonVersion},
		"pull fails": {change: func(_ *moveFixture, _ *movedPanel, req *agentv1.StartMovedPanelRequest) {
			req.Spec.Image.Digest = ""
		}, reason: ReasonPull},
	} {
		t.Run(name, func(t *testing.T) {
			fx := newMoveFixture(t)
			prepareTarget(t, fx)
			p := startMovedPanel(t, "0.2.8")
			req := fx.startRequest(t, p)
			tc.change(fx, p, req)
			_, err := fx.m.Start(context.Background(), req)
			if err == nil {
				t.Fatal("started")
			}
			if reasonOf(err) != tc.reason {
				t.Fatalf("reason %q, want %q (%v)", reasonOf(err), tc.reason, err)
			}
			targetIsBack(t, fx)
			if err := fx.m.Abort(context.Background(), &agentv1.AbortMovedPanelRequest{MoveId: testMove}); err != nil {
				t.Fatalf("abort after a failed start: %v", err)
			}
		})
	}
}

func TestStartMovedPanelRefusals(t *testing.T) {
	p := startMovedPanel(t, "0.2.8")
	t.Run("not imported", func(t *testing.T) {
		fx := newMoveFixture(t)
		if _, err := fx.m.Start(context.Background(), fx.startRequest(t, p)); reasonOf(err) != ReasonNotImported {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("staging changed", func(t *testing.T) {
		fx := newMoveFixture(t)
		prepareTarget(t, fx)
		mustWriteFile(t, fx.path(panelIncoming, testMove, "stray"), "x")
		if _, err := fx.m.Start(context.Background(), fx.startRequest(t, p)); reasonOf(err) != ReasonNotImported {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("a panel runs here", func(t *testing.T) {
		fx := newMoveFixture(t)
		prepareTarget(t, fx)
		fx.f.addContainer("seylo-panel-3", true)
		if _, err := fx.m.Start(context.Background(), fx.startRequest(t, p)); reasonOf(err) != ReasonPanelRunning {
			t.Fatalf("err = %v", err)
		}
		if got := readFile(t, fx.path("panel", "panel.db")); got != sqliteFile("old panel") {
			t.Fatal("the live folder was touched")
		}
	})
	for name, change := range map[string]func(*agentv1.StartMovedPanelRequest){
		"other service":   func(r *agentv1.StartMovedPanelRequest) { r.Spec.Id = "app0000000000000" },
		"not protected":   func(r *agentv1.StartMovedPanelRequest) { r.Spec.Protected = false },
		"stopped":         func(r *agentv1.StartMovedPanelRequest) { r.Spec.Stopped = true },
		"no pin":          func(r *agentv1.StartMovedPanelRequest) { r.PanelPin = "" },
		"same ports":      func(r *agentv1.StartMovedPanelRequest) { r.HostPort = r.AgentTlsPort },
		"no version":      func(r *agentv1.StartMovedPanelRequest) { r.ExpectedVersion = "" },
		"endless timeout": func(r *agentv1.StartMovedPanelRequest) { r.HealthTimeout = durationpb.New(48 * time.Hour) },
		"bad id":          func(r *agentv1.StartMovedPanelRequest) { r.MoveId = "a/b" },
	} {
		t.Run(name, func(t *testing.T) {
			fx := newMoveFixture(t)
			req := fx.startRequest(t, p)
			change(req)
			if _, err := fx.m.Start(context.Background(), req); codeOf(err) != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

// An agent restart in the middle of a start (any phase before healthy)
// undoes it on the next start; a healthy one waits for the panel.
func TestResumeUndoesAnInterruptedStart(t *testing.T) {
	for _, phase := range []movePhase{moveActivating, moveStarting} {
		t.Run(string(phase), func(t *testing.T) {
			fx := newMoveFixture(t)
			prepareTarget(t, fx)
			p := startMovedPanel(t, "0.2.8")
			if _, err := fx.m.Start(context.Background(), fx.startRequest(t, p)); err != nil {
				t.Fatal(err)
			}
			var j panelMove
			if err := readJSON(fx.path("update", moveJournal), &j); err != nil {
				t.Fatal(err)
			}
			j.Phase = phase
			if err := writeJSON(fx.path("update", moveJournal), &j); err != nil {
				t.Fatal(err)
			}
			if phase == moveActivating {
				// Before the spec was recorded: the folders were swapped only.
				if err := fx.f.rec.runtime().Uninstall(context.Background(), defaultPanelServiceID); err != nil {
					t.Fatal(err)
				}
				fx.f.mu.Lock()
				fx.f.containers = map[string]*PanelContainer{}
				fx.f.mu.Unlock()
			}
			if err := fx.m.Resume(context.Background()); err != nil {
				t.Fatal(err)
			}
			targetIsBack(t, fx)
		})
	}
	t.Run("healthy", func(t *testing.T) {
		fx := newMoveFixture(t)
		prepareTarget(t, fx)
		p := startMovedPanel(t, "0.2.8")
		if _, err := fx.m.Start(context.Background(), fx.startRequest(t, p)); err != nil {
			t.Fatal(err)
		}
		if err := fx.m.Resume(context.Background()); err != nil {
			t.Fatal(err)
		}
		if !exists(fx.path("update", moveJournal)) || len(fx.f.running()) != 1 {
			t.Fatal("a healthy moved panel was undone by a restart")
		}
		// This agent reaches the moved panel at its staged address: done.
		fx.url = "https://127.0.0.1:" + strconv.Itoa(int(port(t, p.tls)))
		if err := fx.m.Resume(context.Background()); err != nil {
			t.Fatal(err)
		}
		gone(t, fx.path("update", moveJournal))
		// The folder set aside was not this panel's retired copy: it stays.
		if !exists(fx.path(panelBefore + testMove)) {
			t.Fatal("a folder of unknown origin was deleted")
		}
	})
}

// A journal step written before its rename must never make undo delete a
// folder the move did not put there.
func TestUndoNeverDeletesAFolderItDidNotMoveIn(t *testing.T) {
	fx := newMoveFixture(t)
	mustWriteFile(t, fx.path("panel", "panel.db"), sqliteFile("live panel"))
	mustWriteFile(t, fx.path("registry", "blob"), "live blob")
	if err := os.MkdirAll(fx.path(panelIncoming, testMove), 0o700); err != nil {
		t.Fatal(err)
	}
	staged, _ := idOf(fx.path(panelIncoming, testMove))
	j := &panelMove{MoveID: testMove, ServiceID: defaultPanelServiceID, Phase: moveActivating,
		PanelIn: true, PanelID: staged, RegistryIn: true, RegistryID: fileID{Dev: 1, Ino: 1}}
	if err := writeJSON(fx.path("update", moveJournal), j); err != nil {
		t.Fatal(err)
	}
	if err := fx.m.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, fx.path("panel", "panel.db")); got != sqliteFile("live panel") {
		t.Fatalf("panel.db = %q", got)
	}
	if got := readFile(t, fx.path("registry", "blob")); got != "live blob" {
		t.Fatalf("registry = %q", got)
	}
	gone(t, fx.path(panelIncoming, testMove))
	gone(t, fx.path("update", moveJournal))
}

func TestUndoKeepsTheDataWhileThePanelCannotBeRemoved(t *testing.T) {
	fx := newMoveFixture(t)
	prepareTarget(t, fx)
	p := startMovedPanel(t, "0.2.8")
	if _, err := fx.m.Start(context.Background(), fx.startRequest(t, p)); err != nil {
		t.Fatal(err)
	}
	fx.f.failRemove = errors.New("docker did not answer")
	if err := fx.m.Abort(context.Background(), &agentv1.AbortMovedPanelRequest{MoveId: testMove}); reasonOf(err) != ReasonUndo {
		t.Fatalf("err = %v", err)
	}
	// The moved panel may still run on its folder: it stays, and so does the journal.
	if got := readFile(t, fx.path("panel", "panel.db")); got != sqliteFile("moved panel") {
		t.Fatalf("panel.db = %q", got)
	}
	if !exists(fx.path("update", moveJournal)) {
		t.Fatal("the journal went")
	}
	fx.f.failRemove = nil
	if err := fx.m.Abort(context.Background(), &agentv1.AbortMovedPanelRequest{MoveId: testMove}); err != nil {
		t.Fatal(err)
	}
	targetIsBack(t, fx)
}

// Once this node's agent uses the moved panel, an abort cannot stop it.
func TestAbortRefusedOnceTheMovedPanelIsInUse(t *testing.T) {
	fx := newMoveFixture(t)
	prepareTarget(t, fx)
	p := startMovedPanel(t, "0.2.8")
	if _, err := fx.m.Start(context.Background(), fx.startRequest(t, p)); err != nil {
		t.Fatal(err)
	}
	fx.url = "https://127.0.0.1:" + strconv.Itoa(int(port(t, p.tls)))
	if err := fx.m.Abort(context.Background(), &agentv1.AbortMovedPanelRequest{MoveId: testMove}); reasonOf(err) != ReasonPanelHere {
		t.Fatalf("err = %v", err)
	}
	if len(fx.f.running()) != 1 || fx.f.panelSpec() == nil {
		t.Fatal("the panel in use was stopped")
	}
	gone(t, fx.path("update", moveJournal))
}

// startedTarget is a target whose moved panel of testMove runs healthy and
// waits for the switch.
func startedTarget(t *testing.T) *moveFixture {
	t.Helper()
	fx := newMoveFixture(t)
	prepareTarget(t, fx)
	p := startMovedPanel(t, "0.2.8")
	if _, err := fx.m.Start(context.Background(), fx.startRequest(t, p)); err != nil {
		t.Fatal(err)
	}
	return fx
}

func commitReq(id string) *agentv1.CommitMovedPanelRequest {
	return &agentv1.CommitMovedPanelRequest{MoveId: id}
}

func journalPhase(t *testing.T, fx *moveFixture) movePhase {
	t.Helper()
	var j panelMove
	if err := readJSON(fx.path("update", moveJournal), &j); err != nil {
		t.Fatal(err)
	}
	return j.Phase
}

// The switch: recorded in the journal, then the marker the panel waits
// for; again for the same move is fine, and nothing undoes it after.
func TestCommitMovedPanel(t *testing.T) {
	fx := startedTarget(t)
	ctx := context.Background()
	if !fx.m.AwaitsCommit(testMove) || fx.m.AwaitsCommit("mv0000000000000f") {
		t.Fatal("AwaitsCommit before the switch")
	}
	if err := fx.m.Commit(ctx, commitReq("mv0000000000000f")); reasonOf(err) != ReasonNotStarted || codeOf(err) != agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION {
		t.Fatalf("another move's commit = %v", err)
	}
	gone(t, fx.path("panel", commitMarker))
	if os.Geteuid() == 0 {
		// The panel reads the marker as its own user.
		if err := os.Chown(fx.path("panel"), 61000, 61000); err != nil {
			t.Fatal(err)
		}
	}
	if err := fx.m.Commit(ctx, commitReq(testMove)); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, fx.path("panel", commitMarker)); got != testMove {
		t.Fatalf("marker = %q", got)
	}
	info, err := os.Stat(fx.path("panel", commitMarker))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("marker mode = %v, %v", info, err)
	}
	if st, ok := info.Sys().(*syscall.Stat_t); os.Geteuid() == 0 && ok && (st.Uid != 61000 || st.Gid != 61000) {
		t.Fatalf("marker owned by %d:%d, want the panel user", st.Uid, st.Gid)
	}
	if phase := journalPhase(t, fx); phase != moveCommitted {
		t.Fatalf("journal phase %q", phase)
	}
	if fx.m.AwaitsCommit(testMove) {
		t.Fatal("still waiting for the switch after it")
	}
	if err := fx.m.Commit(ctx, commitReq(testMove)); err != nil {
		t.Fatalf("again: %v", err)
	}

	// An abort from now on is refused and leaves the panel alone.
	err = fx.m.Abort(ctx, &agentv1.AbortMovedPanelRequest{MoveId: testMove})
	if reasonOf(err) != ReasonCommitted || codeOf(err) != agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION {
		t.Fatalf("abort after the commit = %v", err)
	}
	if len(fx.f.running()) != 1 || fx.f.panelSpec() == nil || readFile(t, fx.path("panel", "master.key")) != "moved master key" {
		t.Fatal("an abort after the commit touched the moved panel")
	}
	// A restart keeps it.
	if err := fx.m.Resume(ctx); err != nil {
		t.Fatal(err)
	}
	if phase := journalPhase(t, fx); phase != moveCommitted || len(fx.f.running()) != 1 {
		t.Fatalf("after a restart: phase %q, running %v", phase, fx.f.running())
	}

	// This agent reaches the moved panel: the journal goes, the marker
	// still answers for the move.
	fx.m.Arrived(testMove)
	waitFor(t, "the move over here", func() bool { return !exists(fx.path("update", moveJournal)) })
	if err := fx.m.Abort(ctx, &agentv1.AbortMovedPanelRequest{MoveId: testMove}); reasonOf(err) != ReasonCommitted {
		t.Fatalf("abort after the arrival = %v", err)
	}
	if err := fx.m.Commit(ctx, commitReq(testMove)); err != nil {
		t.Fatalf("commit after the arrival = %v", err)
	}
	if len(fx.f.running()) != 1 || readFile(t, fx.path("panel", "panel.db")) != sqliteFile("moved panel") {
		t.Fatal("the moved panel went")
	}
}

// No healthy moved panel of that move: refused with notStarted (nothing
// switched), and the abort still undoes everything.
func TestCommitRefusedWithoutAMovedPanel(t *testing.T) {
	ctx := context.Background()
	t.Run("nothing here", func(t *testing.T) {
		fx := newMoveFixture(t)
		if err := fx.m.Commit(ctx, commitReq(testMove)); reasonOf(err) != ReasonNotStarted {
			t.Fatalf("err = %v", err)
		}
		if err := fx.m.Commit(ctx, commitReq("../x")); reasonOf(err) != ReasonBadRequest {
			t.Fatalf("bad id = %v", err)
		}
	})
	t.Run("only imported", func(t *testing.T) {
		fx := newMoveFixture(t)
		prepareTarget(t, fx)
		if err := fx.m.Commit(ctx, commitReq(testMove)); reasonOf(err) != ReasonNotStarted {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("still starting", func(t *testing.T) {
		fx := startedTarget(t)
		var j panelMove
		if err := readJSON(fx.path("update", moveJournal), &j); err != nil {
			t.Fatal(err)
		}
		j.Phase = moveStarting
		if err := writeJSON(fx.path("update", moveJournal), &j); err != nil {
			t.Fatal(err)
		}
		if err := fx.m.Commit(ctx, commitReq(testMove)); reasonOf(err) != ReasonNotStarted {
			t.Fatalf("err = %v", err)
		}
		gone(t, fx.path("panel", commitMarker))
	})
	t.Run("panel stopped", func(t *testing.T) {
		fx := startedTarget(t)
		fx.f.mu.Lock()
		for _, c := range fx.f.containers {
			c.Running = false
		}
		fx.f.mu.Unlock()
		if err := fx.m.Commit(ctx, commitReq(testMove)); reasonOf(err) != ReasonNotStarted {
			t.Fatalf("err = %v", err)
		}
		if phase := journalPhase(t, fx); phase != moveHealthy {
			t.Fatalf("phase %q", phase)
		}
		if err := fx.m.Abort(ctx, &agentv1.AbortMovedPanelRequest{MoveId: testMove}); err != nil {
			t.Fatal(err)
		}
		targetIsBack(t, fx)
	})
	t.Run("docker does not answer", func(t *testing.T) {
		fx := startedTarget(t)
		fx.f.mu.Lock()
		fx.f.listErr = errors.New("docker is restarting")
		fx.f.mu.Unlock()
		// Not a refusal: the old panel tries again.
		if err := fx.m.Commit(ctx, commitReq(testMove)); reasonOf(err) != ReasonCommit || codeOf(err) != agentv1.StatusCode_STATUS_CODE_UNAVAILABLE {
			t.Fatalf("err = %v", err)
		}
		if phase := journalPhase(t, fx); phase != moveHealthy {
			t.Fatalf("phase %q", phase)
		}
	})
	t.Run("busy", func(t *testing.T) {
		saved := moveCommitWait
		t.Cleanup(func() { moveCommitWait = saved })
		moveCommitWait = 20 * time.Millisecond
		fx := startedTarget(t)
		release, _ := fx.lock.TryAcquire(holdPanelUpdate)
		defer release()
		if err := fx.m.Commit(ctx, commitReq(testMove)); reasonOf(err) != ReasonBusy || codeOf(err) != agentv1.StatusCode_STATUS_CODE_ABORTED {
			t.Fatalf("err = %v", err)
		}
	})
}

// A marker that cannot be written switched nothing: the journal goes back
// to healthy, so an abort still undoes the move; a retry writes it.
func TestCommitMarkerFailure(t *testing.T) {
	fx := startedTarget(t)
	ctx := context.Background()
	// A folder in the marker's place: the rename onto it fails, as root too.
	if err := os.Mkdir(fx.path("panel", commitMarker), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := fx.m.Commit(ctx, commitReq(testMove)); reasonOf(err) != ReasonCommit || codeOf(err) != agentv1.StatusCode_STATUS_CODE_UNAVAILABLE {
		t.Fatalf("err = %v", err)
	}
	if phase := journalPhase(t, fx); phase != moveHealthy {
		t.Fatalf("phase %q after a failed marker", phase)
	}
	if !fx.m.AwaitsCommit(testMove) {
		t.Fatal("the failed switch counts as done")
	}
	if err := os.Remove(fx.path("panel", commitMarker)); err != nil {
		t.Fatal(err)
	}
	if err := fx.m.Commit(ctx, commitReq(testMove)); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, fx.path("panel", commitMarker)); got != testMove {
		t.Fatalf("marker = %q", got)
	}
}

// The agent stopped between the journal and the marker: the next start
// writes the marker, keeps the moved panel and never undoes it.
func TestResumeFinishesACommit(t *testing.T) {
	fx := startedTarget(t)
	var j panelMove
	if err := readJSON(fx.path("update", moveJournal), &j); err != nil {
		t.Fatal(err)
	}
	j.Phase = moveCommitted
	if err := writeJSON(fx.path("update", moveJournal), &j); err != nil {
		t.Fatal(err)
	}
	if err := fx.m.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, fx.path("panel", commitMarker)); got != testMove {
		t.Fatalf("marker = %q", got)
	}
	if phase := journalPhase(t, fx); phase != moveCommitted || len(fx.f.running()) != 1 || fx.f.panelSpec() == nil {
		t.Fatalf("phase %q, running %v: a committed move was undone", phase, fx.f.running())
	}
	// Once this agent dials the moved panel, a restart ends the move here.
	fx.url = "https://127.0.0.1:" + strconv.Itoa(int(j.AgentTLSPort))
	if err := fx.m.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	gone(t, fx.path("update", moveJournal))
}

// A committed move whose agent has not arrived yet is never undone to make
// room for another move.
func TestAnotherMoveNeverUndoesACommittedOne(t *testing.T) {
	fx := startedTarget(t)
	ctx := context.Background()
	if err := fx.m.Commit(ctx, commitReq(testMove)); err != nil {
		t.Fatal(err)
	}
	// Its container stopped (a crash), so nothing refuses the import as a running panel.
	fx.f.mu.Lock()
	for _, c := range fx.f.containers {
		c.Running = false
	}
	fx.f.mu.Unlock()
	if _, err := fx.importData(t, "mv0000000000000f", panelData()); reasonOf(err) != ReasonMoveUnfinished {
		t.Fatalf("import of another move = %v", err)
	}
	if readFile(t, fx.path("panel", "master.key")) != "moved master key" || journalPhase(t, fx) != moveCommitted {
		t.Fatal("the committed move was undone")
	}
}

// Arriving ends the move here; the retired copy of this same panel that
// was set aside goes with it.
func TestArrivedDeletesTheRetiredCopy(t *testing.T) {
	fx := newMoveFixture(t)
	prepareTarget(t, fx)
	if err := writeJSON(fx.path("update", retireJournal), &panelRetire{MoveID: "mv0000000000000a", ServiceID: defaultPanelServiceID, Phase: retired}); err != nil {
		t.Fatal(err)
	}
	p := startMovedPanel(t, "0.2.8")
	if _, err := fx.m.Start(context.Background(), fx.startRequest(t, p)); err != nil {
		t.Fatal(err)
	}
	if _, ok := fx.m.Retired(); !ok {
		t.Fatal("the retire journal went before the move was over")
	}
	fx.m.Arrived("mv0000000000000f") // another move: nothing
	time.Sleep(50 * time.Millisecond)
	if !exists(fx.path("update", moveJournal)) {
		t.Fatal("another move's arrival ended this one")
	}
	fx.m.Arrived(testMove)
	deadline := time.Now().Add(5 * time.Second)
	for exists(fx.path("update", moveJournal)) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	gone(t, fx.path("update", moveJournal))
	gone(t, fx.path(panelBefore+testMove))
	gone(t, fx.path(registryBefore+testMove))
	if _, ok := fx.m.Retired(); ok {
		t.Fatal("the node still counts as retired")
	}
	if got := readFile(t, fx.path("panel", "master.key")); got != "moved master key" {
		t.Fatalf("live master.key = %q", got)
	}
}

func TestRegistryExportImport(t *testing.T) {
	src := newMoveFixture(t)
	mustWriteFile(t, src.path("registry", "docker", "registry", "v2", "blobs", "sha256", "ab", "data"), "layer bytes")
	mustWriteFile(t, src.path("registry", "docker", "registry", "v2", "repositories", "svc", "link"), "sha256:ab")
	var buf bytes.Buffer
	exp, err := src.m.ExportRegistry(context.Background(), &agentv1.ExportRegistryRequest{MoveId: testMove}, &buf)
	if err != nil {
		t.Fatal(err)
	}
	dst := newMoveFixture(t)
	imp, err := dst.m.ImportRegistry(context.Background(), &agentv1.ImportRegistryRequest{MoveId: testMove, SizeBytes: uint64(buf.Len())}, bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if exp.GetSizeBytes() != imp.GetSizeBytes() || exp.GetSizeBytes() != uint64(len("layer bytes")+len("sha256:ab")) {
		t.Fatalf("exported %d, imported %d", exp.GetSizeBytes(), imp.GetSizeBytes())
	}
	if got := readFile(t, dst.path(registryIncoming, testMove, "docker", "registry", "v2", "blobs", "sha256", "ab", "data")); got != "layer bytes" {
		t.Fatalf("staged blob = %q", got)
	}
	gone(t, dst.path("registry"))

	// No registry storage: an empty archive, 0 bytes.
	empty := newMoveFixture(t)
	buf.Reset()
	if exp, err := empty.m.ExportRegistry(context.Background(), &agentv1.ExportRegistryRequest{MoveId: testMove}, &buf); err != nil || exp.GetSizeBytes() != 0 {
		t.Fatalf("export = %v, %v", exp, err)
	}
	if imp, err := dst.m.ImportRegistry(context.Background(), &agentv1.ImportRegistryRequest{MoveId: testMove}, bytes.NewReader(buf.Bytes())); err != nil || imp.GetSizeBytes() != 0 {
		t.Fatalf("import = %v, %v", imp, err)
	}

	// No room for it: refused before anything is written, and a stream
	// larger than the room stops at the reserve.
	dst.free = 32 << 20
	if _, err := dst.m.ImportRegistry(context.Background(), &agentv1.ImportRegistryRequest{MoveId: testMove, SizeBytes: 1 << 20}, bytes.NewReader(nil)); reasonOf(err) != ReasonNoSpace {
		t.Fatalf("err = %v", err)
	}
	dst.free = moveReserve + 4
	big := tarGz(t, tarEntry{hdr: tar.Header{Name: "blob"}, body: "more than four bytes"})
	if _, err := dst.m.ImportRegistry(context.Background(), &agentv1.ImportRegistryRequest{MoveId: testMove}, bytes.NewReader(big)); reasonOf(err) != ReasonNoSpace {
		t.Fatalf("err = %v", err)
	}
	gone(t, dst.path(registryIncoming, testMove))
}

func TestRetirePanel(t *testing.T) {
	fx := newMoveFixture(t)
	fx.m.SetBackground(context.Background())
	spec := &agentv1.ServiceSpec{Id: defaultPanelServiceID, Name: "panel", Protected: true, Generation: 3, Image: &agentv1.ImageRef{Reference: "panel:1", Digest: "sha256:1"}}
	if err := fx.f.rec.runtime().Install(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	if err := fx.m.Retire(context.Background(), &agentv1.RetirePanelRequest{MoveId: testMove, ServiceId: defaultPanelServiceID}); err != nil {
		t.Fatal(err)
	}
	// The retire holds the update lock until it is done.
	if h := fx.lock.Holder(); h != holdPanelRetire && h != "" {
		t.Fatalf("lock holder = %q", h)
	}
	waitFor(t, "the old panel stopped", func() bool {
		var r panelRetire
		return readJSON(fx.path("update", retireJournal), &r) == nil && r.Phase == retired && fx.lock.Holder() == ""
	})
	if got := fx.f.panelSpec(); got == nil || !got.GetStopped() {
		t.Fatalf("spec = %v, want kept and stopped", got)
	}
	if run := fx.f.running(); len(run) != 0 || fx.f.count() != 1 {
		t.Fatalf("running %v, containers %d: the stopped container must stay", run, fx.f.count())
	}
	if id, ok := fx.m.Retired(); !ok || id != testMove {
		t.Fatalf("Retired = %q, %v", id, ok)
	}
	// Something sets the spec running again: the next start stops it.
	spec.Stopped = false
	if err := fx.f.rec.runtime().Install(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	if err := fx.m.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the retired panel stopped again", func() bool {
		return fx.f.panelSpec().GetStopped() && len(fx.f.running()) == 0
	})
}

// While a moved panel waits on this node for the switch, the retire
// journal of the copy it set aside never stops it.
func TestResumeLeavesTheMovedPanelToTheMove(t *testing.T) {
	fx := newMoveFixture(t)
	prepareTarget(t, fx)
	if err := writeJSON(fx.path("update", retireJournal), &panelRetire{MoveID: "mv0000000000000a", ServiceID: defaultPanelServiceID, Phase: retired}); err != nil {
		t.Fatal(err)
	}
	p := startMovedPanel(t, "0.2.8")
	if _, err := fx.m.Start(context.Background(), fx.startRequest(t, p)); err != nil {
		t.Fatal(err)
	}
	if err := fx.m.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if spec := fx.f.panelSpec(); spec.GetStopped() || len(fx.f.running()) != 1 {
		t.Fatalf("the moved panel was stopped: %v", spec)
	}
}

// The registry this node had goes aside even when the old panel node had
// none to move: the moved panel never sees older images.
func TestStartSetsTheRegistryAsideWithoutOneMoved(t *testing.T) {
	fx := newMoveFixture(t)
	mustWriteFile(t, fx.path("registry", "docker", "old-blob"), "old blob")
	if _, err := fx.importData(t, testMove, panelData()); err != nil {
		t.Fatal(err)
	}
	p := startMovedPanel(t, "0.2.8")
	if _, err := fx.m.Start(context.Background(), fx.startRequest(t, p)); err != nil {
		t.Fatal(err)
	}
	gone(t, fx.path("registry"))
	if got := readFile(t, fx.path(registryBefore+testMove, "docker", "old-blob")); got != "old blob" {
		t.Fatalf("aside = %q", got)
	}
	gone(t, fx.path(panelIncoming))
	if err := fx.m.Abort(context.Background(), &agentv1.AbortMovedPanelRequest{MoveId: testMove}); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, fx.path("registry", "docker", "old-blob")); got != "old blob" {
		t.Fatalf("registry after the abort = %q", got)
	}
	gone(t, fx.path("panel"))
}

// The agent restarted between the answer and the stop: the next start
// finishes it, also once the moved panel took the spec away.
func TestRetireResume(t *testing.T) {
	fx := newMoveFixture(t)
	fx.f.addContainer("seylo-panel-3", true)
	if err := writeJSON(fx.path("update", retireJournal), &panelRetire{MoveID: testMove, ServiceID: defaultPanelServiceID, Phase: retiring}); err != nil {
		t.Fatal(err)
	}
	if err := fx.m.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the retire finished", func() bool {
		var r panelRetire
		return readJSON(fx.path("update", retireJournal), &r) == nil && r.Phase == retired
	})
	if run := fx.f.running(); len(run) != 0 {
		t.Fatalf("running = %v", run)
	}
}

// A stop that fails is tried again until it works.
func TestRetireRetriesTheStop(t *testing.T) {
	fx := newMoveFixture(t)
	fx.m.SetBackground(context.Background())
	fx.f.addContainer("seylo-panel-3", true)
	fx.f.mu.Lock()
	fx.f.listErr = errors.New("docker is restarting")
	fx.f.mu.Unlock()
	if err := writeJSON(fx.path("update", retireJournal), &panelRetire{MoveID: testMove, ServiceID: defaultPanelServiceID, Phase: retiring}); err != nil {
		t.Fatal(err)
	}
	if err := fx.m.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	var r panelRetire
	if err := readJSON(fx.path("update", retireJournal), &r); err != nil || r.Phase != retiring {
		t.Fatalf("journal = %+v, %v", r, err)
	}
	fx.f.mu.Lock()
	fx.f.listErr = nil
	fx.f.mu.Unlock()
	waitFor(t, "the retire finished", func() bool {
		return readJSON(fx.path("update", retireJournal), &r) == nil && r.Phase == retired
	})
	if run := fx.f.running(); len(run) != 0 {
		t.Fatalf("running = %v", run)
	}
}

func TestRetireRefusals(t *testing.T) {
	fx := newMoveFixture(t)
	if err := fx.m.Retire(context.Background(), &agentv1.RetirePanelRequest{MoveId: testMove, ServiceId: defaultPanelServiceID}); reasonOf(err) != ReasonNoPanel {
		t.Fatalf("err = %v", err)
	}
	if err := fx.m.Retire(context.Background(), &agentv1.RetirePanelRequest{MoveId: testMove, ServiceId: "app0000000000000"}); reasonOf(err) != ReasonBadRequest {
		t.Fatalf("err = %v", err)
	}
	gone(t, fx.path("update", retireJournal))
}

func TestRemoveOldPanel(t *testing.T) {
	setup := func(t *testing.T) *moveFixture {
		fx := newMoveFixture(t)
		fx.url = "https://203.0.113.9:3443"
		mustWriteFile(t, fx.path("panel", "panel.db"), sqliteFile("old"))
		mustWriteFile(t, fx.path("panel", "master.key"), "0123456789")
		mustWriteFile(t, fx.path("update", panelSnaps, "20261101T000000Z-u1", "panel.db"), "snap")
		mustWriteFile(t, fx.path("registry", "blob"), "blob")
		mustWriteFile(t, fx.path(panelBefore+"mvold", "master.key"), "older")
		mustWriteFile(t, fx.path(panelIncoming, "mvstale", "panel.db"), "stale")
		mustWriteFile(t, fx.path("services", "app", "volumes", "data", "keep"), "a service's data")
		fx.f.addContainer("seylo-panel-3", false)
		spec := &agentv1.ServiceSpec{Id: defaultPanelServiceID, Protected: true, Stopped: true, Generation: 3}
		if err := fx.f.rec.runtime().Install(context.Background(), spec); err != nil {
			t.Fatal(err)
		}
		_ = writeJSON(fx.path("update", retireJournal), &panelRetire{MoveID: testMove, ServiceID: defaultPanelServiceID, Phase: retired})
		return fx
	}
	req := &agentv1.RemoveOldPanelRequest{ServiceId: defaultPanelServiceID}
	t.Run("removes the copy", func(t *testing.T) {
		fx := setup(t)
		res, err := fx.m.RemoveOld(context.Background(), req)
		if err != nil {
			t.Fatal(err)
		}
		if want := uint64(len(sqliteFile("old")) + 10 + 4 + 4 + 5 + 5); res.GetFreedBytes() != want {
			t.Fatalf("freed %d, want %d", res.GetFreedBytes(), want)
		}
		for _, p := range []string{"panel", "registry", filepath.Join("update", panelSnaps), panelBefore + "mvold", panelIncoming, filepath.Join("update", retireJournal)} {
			gone(t, fx.path(p))
		}
		if got := readFile(t, fx.path("services", "app", "volumes", "data", "keep")); got != "a service's data" {
			t.Fatal("a service's data went")
		}
		if fx.f.count() != 0 || fx.f.panelSpec() != nil || fx.f.regRemoved != 1 {
			t.Fatalf("containers %d, spec %v, registry removed %d", fx.f.count(), fx.f.panelSpec(), fx.f.regRemoved)
		}
	})
	for name, change := range map[string]func(fx *moveFixture){
		"panel runs":           func(fx *moveFixture) { fx.f.addContainer("seylo-panel-4", true) },
		"agent dials loopback": func(fx *moveFixture) { fx.url = "http://127.0.0.1:3000" },
		"desired runs it": func(fx *moveFixture) {
			_ = fx.f.rec.runtime().Install(context.Background(), &agentv1.ServiceSpec{Id: defaultPanelServiceID, Protected: true, Generation: 3})
		},
		"a move here is open": func(fx *moveFixture) { _ = writeJSON(fx.path("update", moveJournal), &panelMove{MoveID: "mvx"}) },
		"loopback over https": func(fx *moveFixture) { fx.url = "https://localhost:3443" },
	} {
		t.Run(name, func(t *testing.T) {
			fx := setup(t)
			change(fx)
			if _, err := fx.m.RemoveOld(context.Background(), req); err == nil {
				t.Fatal("removed")
			}
			if got := readFile(t, fx.path("panel", "master.key")); got != "0123456789" {
				t.Fatal("the panel's data went")
			}
		})
	}
}

func TestSecureRemoveOverwritesKeys(t *testing.T) {
	dir := t.TempDir()
	key := filepath.Join(dir, "panel", "master.key")
	mustWriteFile(t, key, "secret")
	link := filepath.Join(dir, "panel", "linked.key")
	outside := filepath.Join(dir, "outside.key")
	mustWriteFile(t, outside, "not ours")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	// Keep a handle: the bytes it reads after the delete are what was overwritten.
	f, err := os.Open(key)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := secureRemoveAll(filepath.Join(dir, "panel")); err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(f)
	if string(b) == "secret" || len(b) != len("secret") {
		t.Fatalf("master.key still reads %q", b)
	}
	if got := readFile(t, outside); got != "not ours" {
		t.Fatal("a link was followed")
	}
	gone(t, filepath.Join(dir, "panel"))
}
