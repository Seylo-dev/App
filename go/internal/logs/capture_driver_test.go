package logs

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/console/dockerapi"
	"github.com/seylo-dev/app/go/internal/datadir"
)

// fakeSource answers like Docker: containers with the "none" log driver
// have no logs to read (501).
type fakeSource struct {
	mu         sync.Mutex
	containers map[string]*dockerapi.ContainerJSON
	output     map[string][]byte
	inspected  map[string]bool
	logCalls   map[string]int
}

func (f *fakeSource) ListContainers(context.Context, bool, map[string]string) ([]dockerapi.Container, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []dockerapi.Container
	for id, c := range f.containers {
		out = append(out, dockerapi.Container{ID: id, Labels: c.Config.Labels, State: c.State.Status})
	}
	return out, nil
}

func (f *fakeSource) Inspect(_ context.Context, id string) (*dockerapi.ContainerJSON, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.inspected[id] = true
	c, ok := f.containers[id]
	if !ok {
		return nil, &dockerapi.Error{Status: 404, Message: "no such container"}
	}
	cp := *c
	return &cp, nil
}

func (f *fakeSource) Logs(_ context.Context, id string, _ dockerapi.LogsOptions) (io.ReadCloser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logCalls[id]++
	if f.containers[id].HostConfig.LogConfig.Type == "none" {
		return nil, &dockerapi.Error{Status: 501, Message: "configured logging driver does not support reading"}
	}
	return io.NopCloser(bytes.NewReader(f.output[id])), nil
}

func (f *fakeSource) Events(ctx context.Context) (<-chan dockerapi.Event, <-chan error) {
	return make(chan dockerapi.Event), make(chan error)
}

func (f *fakeSource) seen(ids ...string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, id := range ids {
		if !f.inspected[id] {
			return false
		}
	}
	return true
}

func exitedContainer(service, driver string) *dockerapi.ContainerJSON {
	c := &dockerapi.ContainerJSON{}
	c.Config.Labels = map[string]string{labelService: service}
	c.State.Status = "exited"
	c.State.FinishedAt = time.Now().UTC().Format(time.RFC3339Nano)
	c.HostConfig.LogConfig.Type = driver
	return c
}

// A cron run's container uses the "none" log driver (the runner reads its
// output through attach for the run history). The capturer must not ask
// Docker for its logs: Docker answers 501 and logs an error each time.
// Containers with a readable driver are still captured.
func TestCaptureSkipsContainersWithoutReadableLogs(t *testing.T) {
	at := time.Now().UTC().Add(-time.Minute)
	src := &fakeSource{
		containers: map[string]*dockerapi.ContainerJSON{
			"cronrun00001": exitedContainer("svc1", "none"),
			"web000000001": exitedContainer("svc1", "json-file"),
		},
		output: map[string][]byte{
			"web000000001": frame(1, at.Format(time.RFC3339Nano)+" served a request\n"),
		},
		inspected: map[string]bool{},
		logCalls:  map[string]int{},
	}
	store := NewFileStore(datadir.New(t.TempDir()))
	var logs syncBuf
	c := NewCapturer(src, store, filepath.Join(t.TempDir(), ".cursors.json"), slog.New(slog.NewTextHandler(&logs, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Run(ctx) }()

	deadline := time.Now().Add(5 * time.Second)
	for {
		lines, _ := store.Tail("svc1", 10)
		if src.seen("cronrun00001", "web000000001") && slices.ContainsFunc(lines, func(l string) bool { return strings.Contains(l, "served a request") }) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("not captured: lines %q, inspected %v", lines, src.inspected)
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	src.mu.Lock()
	calls := src.logCalls["cronrun00001"]
	src.mu.Unlock()
	if calls != 0 {
		t.Errorf("asked Docker %d times for the logs of a container with the none log driver", calls)
	}
	if out := logs.String(); strings.Contains(out, "cannot be read") {
		t.Errorf("logged:\n%s", out)
	}
}

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}
