package backup

import (
	"io"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// progressWriter counts the bytes the store took and reports them at most
// once per interval.
type progressWriter struct {
	emit     func(*agentv1.BackupProgress)
	req      *agentv1.RunBackupRequest
	interval time.Duration

	mu    sync.Mutex
	n     uint64
	ph    agentv1.BackupPhase
	last  time.Time
	dirty bool
}

func newProgress(emit func(*agentv1.BackupProgress), req *agentv1.RunBackupRequest, interval time.Duration) *progressWriter {
	return &progressWriter{emit: emit, req: req, interval: interval}
}

// reader counts what the store reads from r: the bytes uploaded (or in the
// part being uploaded), not the ones the producer wrote ahead into the
// spool.
func (p *progressWriter) reader(r io.Reader) io.Reader { return progressReader{r: r, p: p} }

type progressReader struct {
	r io.Reader
	p *progressWriter
}

func (pr progressReader) Read(b []byte) (int, error) {
	n, err := pr.r.Read(b)
	if n > 0 {
		pr.p.add(n)
	}
	return n, err
}

func (p *progressWriter) add(n int) {
	p.mu.Lock()
	p.n += uint64(n)
	p.dirty = true
	send := time.Since(p.last) >= p.interval
	p.mu.Unlock()
	if send {
		p.flush()
	}
}

// phase records a phase change and reports it right away.
func (p *progressWriter) phase(ph agentv1.BackupPhase) {
	p.mu.Lock()
	changed := p.ph != ph
	p.ph = ph
	p.dirty = p.dirty || changed
	p.mu.Unlock()
	p.flush()
}

func (p *progressWriter) flush() {
	if p.emit == nil {
		return
	}
	p.mu.Lock()
	if !p.dirty {
		p.mu.Unlock()
		return
	}
	ev := &agentv1.BackupProgress{BackupId: p.req.GetBackupId(), RunId: p.req.GetRunId(), Phase: p.ph, BytesDone: p.n}
	p.dirty = false
	p.last = time.Now()
	p.mu.Unlock()
	p.emit(ev)
}
