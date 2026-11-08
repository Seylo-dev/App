package backup

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// fakeS3 is a path-style bucket "b" that accepts only requests carrying
// the signer's token: object PUT/GET/DELETE and UploadPart. The multipart
// create, complete and abort steps go through the panel (fakeSigner).
type fakeS3 struct {
	mu      sync.Mutex
	objs    map[string][]byte
	uploads map[string]map[int][]byte
	nextID  int
	log     []string
	srv     *httptest.Server
	// failPart makes this part number answer 500; flaky makes the next
	// that many requests answer 503.
	failPart int
	flaky    int
}

func newFakeS3(t *testing.T) *fakeS3 {
	f := &fakeS3{objs: map[string][]byte{}, uploads: map[string]map[int][]byte{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeS3) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	q := r.URL.Query()
	if q.Get("X-Amz-Signature") != "signed-by-panel" {
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, "<Error><Code>AccessDenied</Code><Message>not signed</Message></Error>")
		return
	}
	if r.Header.Get("Transfer-Encoding") != "" || (r.Method == http.MethodPut && r.ContentLength < 0) {
		w.WriteHeader(http.StatusNotImplemented)
		fmt.Fprint(w, "<Error><Code>NotImplemented</Code><Message>chunked</Message></Error>")
		return
	}
	key := strings.TrimPrefix(r.URL.Path, "/b/")
	f.log = append(f.log, r.Method+" "+opName(q))
	if f.flaky > 0 {
		f.flaky--
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, "<Error><Code>SlowDown</Code><Message>busy</Message></Error>")
		return
	}
	body, _ := io.ReadAll(r.Body)
	switch {
	case r.Method == http.MethodPost:
		// Not every provider takes POST presigned: the panel makes those steps.
		w.WriteHeader(http.StatusNotImplemented)
		fmt.Fprint(w, "<Error><Code>NotImplemented</Code><Message>presigned POST</Message></Error>")
	case r.Method == http.MethodPut && q.Has("partNumber"):
		n, _ := strconv.Atoi(q.Get("partNumber"))
		if n == f.failPart {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, "<Error><Code>InternalError</Code><Message>try again</Message></Error>")
			return
		}
		f.uploads[q.Get("uploadId")][n] = body
		w.Header().Set("ETag", fmt.Sprintf(`"etag-%d"`, n))
	case r.Method == http.MethodPut:
		f.objs[key] = body
	case r.Method == http.MethodGet:
		b, ok := f.objs[key]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, "<Error><Code>NoSuchKey</Code></Error>")
			return
		}
		_, _ = w.Write(b)
	case r.Method == http.MethodDelete:
		delete(f.objs, key)
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func opName(q url.Values) string {
	for _, k := range []string{"uploads", "partNumber", "uploadId"} {
		if q.Has(k) {
			return k
		}
	}
	return "object"
}

// fakeSigner stands in for the panel: it presigns the requests a node
// sends and makes the multipart steps itself, the way
// apps/panel/src/modules/backups/signing.ts does.
type fakeSigner struct {
	mu   sync.Mutex
	s3   *fakeS3
	id   string
	seen []*agentv1.BackupStorageRequest
	deny func(*agentv1.BackupStorageRequest) bool
	// unavailable answers the next that many calls UNAVAILABLE.
	unavailable int
}

func (s *fakeSigner) SignBackupRequests(_ context.Context, req *agentv1.SignBackupRequestsRequest) (*agentv1.SignBackupRequestsResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unavailable > 0 {
		s.unavailable--
		return nil, &rpc.Error{Code: agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, Message: "offline"}
	}
	if req.GetSigningId() != s.id {
		return nil, &rpc.Error{Code: agentv1.StatusCode_STATUS_CODE_PERMISSION_DENIED, Message: "not running"}
	}
	out := &agentv1.SignBackupRequestsResponse{}
	for _, r := range req.GetRequests() {
		s.seen = append(s.seen, r)
		if s.deny != nil && s.deny(r) {
			return nil, &rpc.Error{Code: agentv1.StatusCode_STATUS_CODE_PERMISSION_DENIED, Message: "the panel signs only requests on this backup's own object"}
		}
		q := url.Values{"X-Amz-Signature": {"signed-by-panel"}}
		method := ""
		switch r.GetOp() {
		case agentv1.BackupStorageOp_BACKUP_STORAGE_OP_PUT:
			method = http.MethodPut
		case agentv1.BackupStorageOp_BACKUP_STORAGE_OP_UPLOAD_PART:
			method = http.MethodPut
			q.Set("partNumber", strconv.Itoa(int(r.GetPartNumber())))
			q.Set("uploadId", r.GetUploadId())
		case agentv1.BackupStorageOp_BACKUP_STORAGE_OP_GET:
			method = http.MethodGet
		case agentv1.BackupStorageOp_BACKUP_STORAGE_OP_DELETE:
			method = http.MethodDelete
		case agentv1.BackupStorageOp_BACKUP_STORAGE_OP_CREATE_MULTIPART:
			s.s3.mu.Lock()
			s.s3.nextID++
			id := fmt.Sprintf("up-%d", s.s3.nextID)
			s.s3.uploads[id] = map[int][]byte{}
			s.s3.mu.Unlock()
			out.Requests = append(out.Requests, &agentv1.SignedStorageRequest{UploadId: id})
			continue
		case agentv1.BackupStorageOp_BACKUP_STORAGE_OP_COMPLETE_MULTIPART:
			s.s3.mu.Lock()
			parts := s.s3.uploads[r.GetUploadId()]
			var all []byte
			for i, p := range r.GetParts() {
				if int(p.GetPartNumber()) != i+1 || p.GetEtag() != fmt.Sprintf(`"etag-%d"`, i+1) {
					s.s3.mu.Unlock()
					return nil, fmt.Errorf("UNAVAILABLE: part %d has etag %s", p.GetPartNumber(), p.GetEtag())
				}
				all = append(all, parts[int(p.GetPartNumber())]...)
			}
			s.s3.objs[r.GetKey()] = all
			delete(s.s3.uploads, r.GetUploadId())
			s.s3.mu.Unlock()
			out.Requests = append(out.Requests, &agentv1.SignedStorageRequest{})
			continue
		case agentv1.BackupStorageOp_BACKUP_STORAGE_OP_ABORT_MULTIPART:
			s.s3.mu.Lock()
			delete(s.s3.uploads, r.GetUploadId())
			s.s3.mu.Unlock()
			out.Requests = append(out.Requests, &agentv1.SignedStorageRequest{})
			continue
		default:
			return nil, errors.New("unknown op")
		}
		out.Requests = append(out.Requests, &agentv1.SignedStorageRequest{Method: method, Url: s.s3.srv.URL + "/b/" + r.GetKey() + "?" + q.Encode()})
	}
	return out, nil
}

func (s *fakeSigner) ops() []agentv1.BackupStorageOp {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []agentv1.BackupStorageOp
	for _, r := range s.seen {
		out = append(out, r.GetOp())
	}
	return out
}

func signedStore(t *testing.T, signer *fakeSigner, part int) *SignedStore {
	t.Helper()
	saved := retryDelay
	retryDelay = time.Millisecond
	t.Cleanup(func() { retryDelay = saved })
	s, err := OpenSigned(signer, &agentv1.BackupDestination{Bucket: "b", SigningId: signer.id})
	must(t, err)
	s.partSize = part
	return s
}

func TestSignedStorePutGetDelete(t *testing.T) {
	s3 := newFakeS3(t)
	signer := &fakeSigner{s3: s3, id: "run1"}
	store := signedStore(t, signer, 8)
	ctx := context.Background()

	// Smaller than a part: one PUT. An empty stream too (with a length, not chunked).
	n, err := store.Put(ctx, "p/s/b/small", strings.NewReader("tiny"))
	must(t, err)
	if n != 4 || string(s3.objs["p/s/b/small"]) != "tiny" {
		t.Fatalf("small put = %d %q", n, s3.objs["p/s/b/small"])
	}
	if _, err := store.Put(ctx, "p/s/b/empty", strings.NewReader("")); err != nil {
		t.Fatalf("empty put: %v", err)
	}

	// Larger: multipart, parts in order, the last one short; exactly two parts too.
	for _, data := range []string{"0123456789abcdefXYZ", "0123456789abcdef"} {
		n, err = store.Put(ctx, "p/s/b/big", strings.NewReader(data))
		must(t, err)
		if n != int64(len(data)) || string(s3.objs["p/s/b/big"]) != data {
			t.Fatalf("multipart put = %d %q, want %q", n, s3.objs["p/s/b/big"], data)
		}
	}
	if len(s3.uploads) != 0 {
		t.Fatalf("uploads left open: %v", s3.uploads)
	}

	rc, err := store.Get(ctx, "p/s/b/big")
	must(t, err)
	b, _ := io.ReadAll(rc)
	rc.Close()
	if string(b) != "0123456789abcdef" {
		t.Fatalf("get = %q", b)
	}
	if _, err := store.Get(ctx, "p/s/b/missing"); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("missing get = %v", err)
	}

	// The node cannot list: retention is the panel's.
	if _, err := store.List(ctx, "p/s/b/"); !errors.Is(err, ErrListUnsupported) {
		t.Fatalf("list = %v", err)
	}
	must(t, store.Delete(ctx, "p/s/b/small"))
	must(t, store.Delete(ctx, "p/s/b/small")) // already gone: fine
	if _, ok := s3.objs["p/s/b/small"]; ok {
		t.Fatal("delete left the object")
	}
}

func TestSignedStoreAbortsFailedUploadsAndReportsRefusals(t *testing.T) {
	s3 := newFakeS3(t)
	signer := &fakeSigner{s3: s3, id: "run1"}
	store := signedStore(t, signer, 4)
	ctx := context.Background()

	// A busy bucket is retried: two 503s, then the parts go through.
	s3.flaky = 2
	if _, err := store.Put(ctx, "k", strings.NewReader("aaaabbbbcc")); err != nil || string(s3.objs["k"]) != "aaaabbbbcc" {
		t.Fatalf("put after 503s = %v %q", err, s3.objs["k"])
	}
	delete(s3.objs, "k")

	// A part that keeps failing fails the upload after the retries.
	s3.failPart = 2
	before := len(s3.log)
	if _, err := store.Put(ctx, "k", strings.NewReader("aaaabbbbcc")); err == nil || !strings.Contains(err.Error(), "try again") {
		t.Fatalf("failed part = %v", err)
	}
	if tries := strings.Count(strings.Join(s3.log[before:], ","), "PUT partNumber"); tries != 1+attempts {
		t.Fatalf("part requests = %d, want part 1 once and part 2 %d times: %v", tries, attempts, s3.log[before:])
	}
	if len(s3.uploads) != 0 || len(s3.objs) != 0 {
		t.Fatalf("a failed upload left %v / %v", s3.uploads, s3.objs)
	}
	ops := signer.ops()
	if ops[len(ops)-1] != agentv1.BackupStorageOp_BACKUP_STORAGE_OP_ABORT_MULTIPART {
		t.Fatalf("last op = %v, want the abort", ops)
	}

	// The producer fails half way: aborted too.
	s3.failPart = 0
	pr, pw := io.Pipe()
	go func() { _, _ = pw.Write([]byte("aaaabbbb")); pw.CloseWithError(errors.New("pg_dump died")) }()
	if _, err := store.Put(ctx, "k", pr); err == nil || !strings.Contains(err.Error(), "pg_dump died") {
		t.Fatalf("producer failure = %v", err)
	}
	if len(s3.uploads) != 0 || len(s3.objs) != 0 {
		t.Fatalf("a failed producer left %v / %v", s3.uploads, s3.objs)
	}

	// The panel unreachable for a moment (the agent reconnecting): asked again.
	signer.unavailable = 2
	if _, err := store.Put(ctx, "k2", strings.NewReader("x")); err != nil || string(s3.objs["k2"]) != "x" {
		t.Fatalf("put after the panel came back = %v", err)
	}
	delete(s3.objs, "k2")

	// The panel refusing a request fails the operation with its message.
	signer.deny = func(r *agentv1.BackupStorageRequest) bool {
		return r.GetOp() == agentv1.BackupStorageOp_BACKUP_STORAGE_OP_DELETE
	}
	if err := store.Delete(ctx, "other/service/key"); err == nil || !strings.Contains(err.Error(), "own object") {
		t.Fatalf("refused delete = %v", err)
	}
	// A run the panel does not sign for fails; nothing goes out unsigned.
	other := signedStore(t, &fakeSigner{s3: s3, id: "run2"}, 4)
	other.id = "run1-not"
	before = len(s3.log)
	if _, err := other.Put(ctx, "k", strings.NewReader("x")); err == nil {
		t.Fatal("a request the panel did not sign went through")
	}
	if len(s3.log) != before {
		t.Fatalf("the bucket saw %v", s3.log[before:])
	}
}

func TestOpenSignedNeedsASignerAndAValidID(t *testing.T) {
	if _, err := OpenSigned(nil, &agentv1.BackupDestination{SigningId: "run1"}); err == nil {
		t.Fatal("opened a keyless destination without a signer")
	}
	if _, err := OpenSigned(&fakeSigner{}, &agentv1.BackupDestination{SigningId: "../x"}); err == nil {
		t.Fatal("accepted a bad signing id")
	}
}

// A keyless destination goes through the signer end to end: backups (the
// panel sends keep_last 0 and prunes itself), then a restore.
func TestLocalBackupWithKeylessDestination(t *testing.T) {
	s3 := newFakeS3(t)
	signer := &fakeSigner{s3: s3}
	app := &agentv1.ServiceSpec{Id: "app1", ProjectId: "p1", Name: "web", Kind: agentv1.ServiceKind_SERVICE_KIND_APP,
		Volumes: []*agentv1.VolumeMount{{Name: "files", ContainerPath: "/srv"}}}
	layout := datadir.New(t.TempDir())
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	runner := NewLocal(Options{
		Docker: &fakeDocker{}, Layout: layout, Signer: signer,
		Spec: func(id string) *agentv1.ServiceSpec {
			if id == app.GetId() {
				return app
			}
			return nil
		},
		Suspend: func(context.Context, string) (func(context.Context) error, error) {
			return func(context.Context) error { return nil }, nil
		},
		Now: func() time.Time { mu.Lock(); defer mu.Unlock(); now = now.Add(time.Hour); return now },
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = runner.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	for {
		runner.mu.Lock()
		ok := runner.base != nil
		runner.mu.Unlock()
		if ok {
			break
		}
		time.Sleep(time.Millisecond)
	}
	vol, _ := layout.ServiceVolume("app1", "files")
	must(t, os.MkdirAll(vol, 0o755))
	must(t, os.WriteFile(filepath.Join(vol, "a.txt"), []byte("v1"), 0o644))

	var last *agentv1.BackupResult
	for i := 1; i <= 3; i++ {
		run := fmt.Sprintf("run%d", i)
		signer.mu.Lock()
		signer.id = run
		signer.mu.Unlock()
		results := make(chan *agentv1.BackupResult, 1)
		must(t, runner.Start(context.Background(), &agentv1.RunBackupRequest{BackupId: "pol1", RunId: run,
			Subject:     &agentv1.BackupSubject{ServiceId: "app1", What: &agentv1.BackupSubject_Volume{Volume: "files"}},
			Destination: &agentv1.BackupDestination{Prefix: "node1", Bucket: "b", SigningId: run}},
			func(r *agentv1.BackupResult) { results <- r }))
		select {
		case last = <-results:
		case <-time.After(5 * time.Second):
			t.Fatal("no result")
		}
		if !last.GetSuccess() {
			t.Fatalf("run %d: %v", i, last.GetError())
		}
	}
	if len(s3.objs) != 3 || len(last.GetPrunedObjectKeys()) != 0 || !strings.HasPrefix(last.GetObjectKey(), "node1/app1/pol1/") {
		t.Fatalf("objects %v, last %v", s3.objs, last)
	}
	for _, r := range signer.seen {
		if r.GetOp() == agentv1.BackupStorageOp_BACKUP_STORAGE_OP_UNSPECIFIED {
			t.Fatalf("unsigned op in %v", signer.seen)
		}
	}

	must(t, os.WriteFile(filepath.Join(vol, "a.txt"), []byte("v2"), 0o644))
	signer.mu.Lock()
	signer.id = "restore1"
	signer.mu.Unlock()
	resp, err := runner.Restore(context.Background(), &agentv1.RestoreBackupRequest{ObjectKey: last.GetObjectKey(),
		Subject:     &agentv1.BackupSubject{ServiceId: "app1", What: &agentv1.BackupSubject_Volume{Volume: "files"}},
		Destination: &agentv1.BackupDestination{Prefix: "node1", Bucket: "b", SigningId: "restore1"}})
	must(t, err)
	if b, _ := os.ReadFile(filepath.Join(vol, "a.txt")); string(b) != "v1" || resp.GetRestoredBytes() == 0 {
		t.Fatalf("after restore a.txt = %q (%d bytes)", b, resp.GetRestoredBytes())
	}
	if !bytes.Contains([]byte(strings.Join(s3.log, " ")), []byte("GET object")) {
		t.Fatalf("restore did not download through a signed GET: %v", s3.log)
	}
}
