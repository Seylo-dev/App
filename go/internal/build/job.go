package build

import (
	"context"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Output kept per job for watchers that attach late (a panel that
// reconnected mid-build). Older output is dropped first.
const maxJobOutput = 8 << 20

// tailKeep is how much of the last output a job keeps for the hints after
// a failure (failureHint): BuildKit ends a failed build with the error.
const tailKeep = 64 << 10

// Job is one queued or running build. Its output is kept so any number of
// watchers can replay it and follow along; the build itself does not
// depend on anyone watching.
type Job struct {
	ID        string
	ServiceID string

	cancel context.CancelFunc

	mu      sync.Mutex
	items   []*agentv1.BuildResponse
	first   int // sequence number of items[0]
	bytes   int
	pending []byte // log bytes not yet turned into an item
	tail    []byte // the last log bytes, for recent (up to twice tailKeep)
	changed chan struct{}
	final   *agentv1.BuildProgress
	done    chan struct{}
	// commit is the one BuildSourceInfo reported, for the final progress
	// (builtCommit): replayed output may have dropped that message.
	commit string
	// finishedAt is written once, before final is set under mu.
	finishedAt time.Time
	// secretArgs are the Dockerfile's ARG names that are secret variables
	// (they stay empty in the build). Only the build's own goroutine
	// writes and reads them.
	secretArgs []string
}

func newJob(id, serviceID string, cancel context.CancelFunc) *Job {
	return &Job{ID: id, ServiceID: serviceID, cancel: cancel, changed: make(chan struct{}), done: make(chan struct{})}
}

// Done is closed when the build reached a final stage.
func (j *Job) Done() <-chan struct{} { return j.done }

// Final returns the final progress, or nil while the build runs.
func (j *Job) Final() *agentv1.BuildProgress {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.final
}

// Write appends raw builder output. It never fails, so a slow or gone
// watcher never breaks a build.
func (j *Job) Write(b []byte) (int, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.pending = append(j.pending, b...)
	if len(j.pending) >= 16<<10 {
		j.flushLocked()
	}
	j.tail = append(j.tail, b...)
	if len(j.tail) > 2*tailKeep {
		j.tail = append([]byte(nil), j.tail[len(j.tail)-tailKeep:]...)
	}
	return len(b), nil
}

// recent returns the last output, up to tailKeep bytes.
func (j *Job) recent() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	t := j.tail
	if len(t) > tailKeep {
		t = t[len(t)-tailKeep:]
	}
	return string(t)
}

// flush turns pending log bytes into an item. The job's ticker calls it so
// watchers see output within a fraction of a second.
func (j *Job) flush() {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.flushLocked()
}

func (j *Job) flushLocked() {
	if len(j.pending) == 0 {
		return
	}
	j.appendLocked(&agentv1.BuildResponse{Output: &agentv1.BuildResponse_Log{Log: j.pending}})
	j.pending = nil
}

func (j *Job) progress(p *agentv1.BuildProgress) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.flushLocked()
	j.appendLocked(&agentv1.BuildResponse{Output: &agentv1.BuildResponse_Progress{Progress: p}})
}

func (j *Job) sourceInfo(info *agentv1.BuildSourceInfo) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.commit = info.GetCommit()
	j.flushLocked()
	j.appendLocked(&agentv1.BuildResponse{Output: &agentv1.BuildResponse_SourceInfo{SourceInfo: info}})
}

// builtCommit is the commit the build checked out (BuildSourceInfo), ""
// for sources not from git.
func (j *Job) builtCommit() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.commit
}

func (j *Job) finish(p *agentv1.BuildProgress) {
	j.mu.Lock()
	j.flushLocked()
	j.final = p
	j.appendLocked(&agentv1.BuildResponse{Output: &agentv1.BuildResponse_Progress{Progress: p}})
	j.mu.Unlock()
	close(j.done)
}

func (j *Job) appendLocked(r *agentv1.BuildResponse) {
	j.items = append(j.items, r)
	j.bytes += proto.Size(r)
	for j.bytes > maxJobOutput && len(j.items) > 1 {
		j.bytes -= proto.Size(j.items[0])
		j.items[0] = nil
		j.items = j.items[1:]
		j.first++
	}
	close(j.changed)
	j.changed = make(chan struct{})
}

// Watch sends the job's output from the start (or the oldest kept part)
// and follows it until the build is final or ctx ends. It returns nil
// after sending the final progress, or the first error from send.
func (j *Job) Watch(ctx context.Context, send func(*agentv1.BuildResponse) error) error {
	next := 0
	dropped := false
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		j.mu.Lock()
		if next < j.first {
			next = j.first
			dropped = true
		}
		batch := append([]*agentv1.BuildResponse(nil), j.items[next-j.first:]...)
		next += len(batch)
		final := j.final != nil
		changed := j.changed
		j.mu.Unlock()

		if dropped {
			dropped = false
			if err := send(&agentv1.BuildResponse{Output: &agentv1.BuildResponse_Log{Log: []byte("[earlier output dropped]\n")}}); err != nil {
				return err
			}
		}
		for _, r := range batch {
			if err := send(r); err != nil {
				return err
			}
		}
		if final {
			return nil
		}
		select {
		case <-changed:
		case <-ticker.C:
			j.flush()
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
