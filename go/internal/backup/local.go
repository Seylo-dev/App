package backup

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

// ContainerRunner runs one-off containers (*jobrun.Docker in the agent).
type ContainerRunner interface {
	Run(ctx context.Context, spec jobrun.Spec, stdio jobrun.IO) (jobrun.Result, error)
}

// SuspendFunc stops a service and keeps it stopped (no crash handling)
// until resume is called.
type SuspendFunc func(ctx context.Context, serviceID string) (resume func(context.Context) error, err error)

// Errors callers branch on (the RPC handlers map them to statuses).
var (
	ErrServiceNotFound    = errors.New("service is not on this node")
	ErrSuspendUnavailable = errors.New("service suspend not available on this agent")
	ErrNotStarted         = errors.New("backup runner is not running yet")
)

// Options configure a Local runner.
type Options struct {
	Docker ContainerRunner
	Layout datadir.Layout
	// Spec returns the desired spec of a service on this node, or nil.
	Spec func(serviceID string) *agentv1.ServiceSpec
	// Services returns every desired service on this node, so a volume
	// shared by compose members is stopped in all of them; nil means only
	// the subject is known.
	Services func() []*agentv1.ServiceSpec
	// Suspend is nil until reconcile offers it; volume backups with
	// stop_service, volume restores and Redis restores need it.
	Suspend SuspendFunc
	// Progress receives best-effort progress; may be nil.
	Progress func(*agentv1.BackupProgress)
	// OpenStore opens a destination; nil means OpenS3.
	OpenStore func(*agentv1.BackupDestination) (Store, error)
	Logger    *slog.Logger
	Now       func() time.Time
	// MaxParallel backups at once; more wait. 0 means 2.
	MaxParallel int
}

// Local is the agent's Runner.
type Local struct {
	opts Options
	log  *slog.Logger
	sem  chan struct{}

	mu      sync.Mutex
	base    context.Context
	running map[string]bool
	wg      sync.WaitGroup
}

var _ Runner = (*Local)(nil)

// NewLocal returns a runner; call Run to let it accept backups.
func NewLocal(opts Options) *Local {
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.OpenStore == nil {
		opts.OpenStore = func(d *agentv1.BackupDestination) (Store, error) { return OpenS3(d) }
	}
	if opts.MaxParallel <= 0 {
		opts.MaxParallel = 2
	}
	return &Local{opts: opts, log: opts.Logger, sem: make(chan struct{}, opts.MaxParallel), running: map[string]bool{}}
}

// SetSuspend sets how services are stopped for consistent copies; call it
// before Run.
func (l *Local) SetSuspend(fn SuspendFunc) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.opts.Suspend = fn
}

// Run lets the runner accept backups until ctx ends, then waits for the
// ones in progress (they are cancelled and reported as failed).
func (l *Local) Run(ctx context.Context) error {
	l.mu.Lock()
	l.base = ctx
	l.mu.Unlock()
	<-ctx.Done()
	l.wg.Wait()
	l.mu.Lock()
	l.base = nil
	l.mu.Unlock()
	return nil
}

// Start implements Runner. The backup runs in the background on the
// runner's own context, so it outlives the RPC; a second Start with the
// same run id while it runs is accepted and ignored.
func (l *Local) Start(ctx context.Context, req *agentv1.RunBackupRequest, report func(*agentv1.BackupResult)) error {
	// The backup outlives the call, so it keeps its own copy.
	req = proto.Clone(req).(*agentv1.RunBackupRequest)
	plan, err := l.planBackup(req)
	if err != nil {
		return err
	}
	l.mu.Lock()
	base := l.base
	if base == nil {
		l.mu.Unlock()
		return ErrNotStarted
	}
	if l.running[req.GetRunId()] {
		l.mu.Unlock()
		return nil
	}
	l.running[req.GetRunId()] = true
	l.wg.Add(1)
	l.mu.Unlock()

	go func() {
		defer l.wg.Done()
		defer func() {
			l.mu.Lock()
			delete(l.running, req.GetRunId())
			l.mu.Unlock()
		}()
		res := &agentv1.BackupResult{BackupId: req.GetBackupId(), RunId: req.GetRunId(), StartedAt: timestamppb.New(l.opts.Now())}
		select {
		case l.sem <- struct{}{}:
			err = l.backup(base, plan, res)
			<-l.sem
		case <-base.Done():
			err = base.Err()
		}
		res.FinishedAt = timestamppb.New(l.opts.Now())
		if err != nil {
			res.Success = false
			res.Error = userError(base, err)
			l.log.Warn("backup failed", "service_id", plan.spec.GetId(), "run_id", req.GetRunId(), "err", err)
		} else {
			res.Success = true
			l.log.Info("backup done", "service_id", plan.spec.GetId(), "run_id", req.GetRunId(), "bytes", res.GetSizeBytes(), "key", res.GetObjectKey())
		}
		report(res)
	}()
	return nil
}

// userError is the message shown in the panel.
func userError(base context.Context, err error) string {
	if base.Err() != nil {
		return "the agent shut down during the backup"
	}
	return err.Error()
}

type backupPlan struct {
	req     *agentv1.RunBackupRequest
	spec    *agentv1.ServiceSpec
	dir     string // object folder
	vol     string // volume folder on disk (volume backups)
	volName string
	db      *dbTarget
	store   Store
}

func (l *Local) planBackup(req *agentv1.RunBackupRequest) (*backupPlan, error) {
	subj := req.GetSubject()
	spec := l.opts.Spec(subj.GetServiceId())
	if spec == nil {
		return nil, fmt.Errorf("%w: %s", ErrServiceNotFound, subj.GetServiceId())
	}
	backupID := req.GetBackupId()
	if backupID == "" {
		backupID = "adhoc"
	}
	dir, err := backupDir(req.GetDestination().GetPrefix(), spec.GetId(), backupID)
	if err != nil {
		return nil, err
	}
	if !segmentRe.MatchString(req.GetRunId()) {
		return nil, fmt.Errorf("%w: run id %q", ErrBadRequest, req.GetRunId())
	}
	p := &backupPlan{req: req, spec: spec, dir: dir}
	switch w := subj.GetWhat().(type) {
	case *agentv1.BackupSubject_Volume:
		if p.vol, err = l.volumeDir(spec, w.Volume); err != nil {
			return nil, err
		}
		p.volName = w.Volume
		if req.GetStopService() && l.opts.Suspend == nil {
			return nil, ErrSuspendUnavailable
		}
	case *agentv1.BackupSubject_Database:
		t, err := targetOf(spec, w.Database.GetDatabase())
		if err != nil {
			return nil, err
		}
		p.db = &t
	default:
		return nil, fmt.Errorf("%w: the subject has neither a volume nor a database", ErrBadRequest)
	}
	if p.store, err = l.opts.OpenStore(req.GetDestination()); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	return p, nil
}

// volumeDir is the folder of a volume the service mounts.
func (l *Local) volumeDir(spec *agentv1.ServiceSpec, name string) (string, error) {
	for _, v := range spec.GetVolumes() {
		if v.GetName() != name {
			continue
		}
		owner := v.GetOwnerServiceId()
		if owner == "" {
			owner = spec.GetId()
		}
		return l.opts.Layout.ServiceVolume(owner, name)
	}
	return "", fmt.Errorf("%w: service %s has no volume %q", ErrBadRequest, spec.GetId(), name)
}

// backup produces the archive or dump and streams it to the store.
func (l *Local) backup(ctx context.Context, p *backupPlan, res *agentv1.BackupResult) error {
	started := l.opts.Now()
	progress := newProgress(l.opts.Progress, p.req, 2*time.Second)

	var ext string
	var produce func(w io.Writer) error
	if p.db != nil {
		job, err := dumpJob(*p.db)
		if err != nil {
			return err
		}
		ext = job.ext
		produce = func(w io.Writer) error { return l.runDump(ctx, p, job, w) }
	} else {
		ext = extVolume
		produce = func(w io.Writer) error {
			if p.req.GetStopService() {
				progress.phase(agentv1.BackupPhase_BACKUP_PHASE_STOPPING_SERVICE)
				// Every service that writes to the folder stops, not only the
				// subject (compose members share the owner's volume).
				resume, err := l.suspendAll(ctx, l.mounters(p.spec, p.volName, true))
				if err != nil {
					return fmt.Errorf("stopping the service: %w", err)
				}
				defer func() {
					progress.phase(agentv1.BackupPhase_BACKUP_PHASE_STARTING_SERVICE)
					if err := resume(context.WithoutCancel(ctx)); err != nil {
						l.log.Error("starting the service after a backup", "service_id", p.spec.GetId(), "err", err)
					}
				}()
			}
			if _, err := os.Stat(p.vol); errors.Is(err, os.ErrNotExist) {
				// A volume nothing wrote to yet is an empty archive, not an
				// error.
				if err := os.MkdirAll(p.vol, 0o755); err != nil {
					return err
				}
			}
			progress.phase(agentv1.BackupPhase_BACKUP_PHASE_UPLOADING)
			return writeArchive(ctx, p.vol, w)
		}
	}
	key, err := objectKey(p.dir, p.req.GetRunId(), started, ext)
	if err != nil {
		return err
	}
	progress.phase(agentv1.BackupPhase_BACKUP_PHASE_UPLOADING)
	n, err := upload(ctx, p.store, key, progress, produce)
	if err != nil {
		return err
	}
	res.ObjectKey, res.SizeBytes = key, uint64(n)

	if keep := int(p.req.GetKeepLast()); keep > 0 {
		progress.phase(agentv1.BackupPhase_BACKUP_PHASE_PRUNING)
		pruned, err := prune(ctx, p.store, p.dir, keep)
		if err != nil {
			// The backup itself worked; old copies stay until next time.
			l.log.Warn("backup retention failed", "service_id", p.spec.GetId(), "err", err)
		}
		if len(pruned) > 0 {
			l.log.Info("backup retention deleted old objects", "service_id", p.spec.GetId(), "count", len(pruned))
		}
		res.PrunedObjectKeys = pruned
	}
	return nil
}

// upload runs produce into a pipe that the store reads, so nothing is
// buffered on disk. A producer failure deletes whatever was uploaded.
func upload(ctx context.Context, store Store, key string, progress *progressWriter, produce func(io.Writer) error) (int64, error) {
	pr, pw := io.Pipe()
	type result struct {
		n   int64
		err error
	}
	done := make(chan result, 1)
	go func() {
		n, err := store.Put(ctx, key, pr)
		if err != nil {
			pr.CloseWithError(err)
		} else {
			// Drain anything the producer still writes (there should be
			// nothing); a stuck producer must not block forever.
			pr.CloseWithError(errors.New("upload finished early"))
		}
		done <- result{n, err}
	}()
	progress.w = pw
	perr := produce(progress)
	pw.CloseWithError(perr) // nil: the store sees EOF and completes
	up := <-done
	progress.flush()
	switch {
	case perr != nil && up.err != nil && errors.Is(perr, up.err):
		// The upload failed first; the producer only saw the closed pipe.
		return 0, up.err
	case perr != nil:
		if up.err == nil {
			// The object holds a partial dump; never leave it looking like
			// a good backup.
			dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
			defer cancel()
			_ = store.Delete(dctx, key)
		}
		return 0, perr
	case up.err != nil:
		return 0, up.err
	}
	return up.n, nil
}

// runDump runs the dump command in a helper container and writes its
// stdout (gzipped when the format needs it) to w.
func (l *Local) runDump(ctx context.Context, p *backupPlan, job dbJob, w io.Writer) error {
	errTail := jobrun.NewTail(20, []string{p.db.password})
	out := w
	var gz *gzip.Writer
	if job.gzip {
		gz = gzip.NewWriter(w)
		out = gz
	}
	res, err := l.opts.Docker.Run(ctx, helperSpec(p.spec, job, "backup-"+p.req.GetRunId()), jobrun.IO{Stdout: out, Stderr: errTail})
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("the dump exited with code %d: %s", res.ExitCode, lastLine(errTail))
	}
	if gz != nil {
		return gz.Close()
	}
	return nil
}

func lastLine(t *jobrun.Tail) string {
	lines := t.Lines()
	for i := len(lines) - 1; i >= 0; i-- {
		if s := strings.TrimSpace(lines[i]); s != "" {
			return s
		}
	}
	return "no output"
}

// helperSpec is the dump or restore container: the database's own image
// on its project network.
func helperSpec(spec *agentv1.ServiceSpec, job dbJob, what string) jobrun.Spec {
	return jobrun.Spec{
		Name:       jobrun.HelperName(spec.GetId(), what),
		Image:      jobrun.ImageRef(spec.GetImage()),
		Auth:       spec.GetImage().GetAuth(),
		Entrypoint: []string{"/bin/sh", "-c"},
		Cmd:        []string{job.script},
		Env:        job.env,
		Labels:     jobrun.Labels(jobrun.OwnerOf(spec), jobrun.RoleBackup, map[string]string{jobrun.LabelRun: what}),
		Network:    jobrun.ProjectNetwork(spec),
	}
}

// prune deletes objects past keep and returns their keys.
func prune(ctx context.Context, store Store, dir string, keep int) ([]string, error) {
	objs, err := store.List(ctx, dir)
	if err != nil {
		return nil, err
	}
	keys := make([]string, len(objs))
	for i, o := range objs {
		keys[i] = o.Key
	}
	var deleted []string
	for _, k := range expired(dir, keys, keep) {
		if err := store.Delete(ctx, k); err != nil {
			return deleted, err
		}
		deleted = append(deleted, k)
	}
	return deleted, nil
}

// Restore implements Runner. It returns when the restore is done.
func (l *Local) Restore(ctx context.Context, req *agentv1.RestoreBackupRequest) (*agentv1.RestoreBackupResponse, error) {
	subj := req.GetSubject()
	spec := l.opts.Spec(subj.GetServiceId())
	if spec == nil {
		return nil, fmt.Errorf("%w: %s", ErrServiceNotFound, subj.GetServiceId())
	}
	key := req.GetObjectKey()
	ext := formatOf(key)
	if key == "" || ext == "" {
		return nil, fmt.Errorf("%w: object key %q is not a backup this agent wrote", ErrBadRequest, key)
	}
	store, err := l.opts.OpenStore(req.GetDestination())
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	switch w := subj.GetWhat().(type) {
	case *agentv1.BackupSubject_Volume:
		if ext != extVolume {
			return nil, fmt.Errorf("%w: %s is not a volume archive", ErrBadRequest, key)
		}
		dir, err := l.volumeDir(spec, w.Volume)
		if err != nil {
			return nil, err
		}
		if l.opts.Suspend == nil {
			return nil, ErrSuspendUnavailable
		}
		return l.restoreVolume(ctx, store, key, l.mounters(spec, w.Volume, false), dir)
	case *agentv1.BackupSubject_Database:
		database := w.Database.GetDatabase()
		if database == "" && ext == extPgCustom {
			database = spec.GetDatabase().GetCredentials().GetDatabase()
		}
		t, err := targetOf(spec, database)
		if err != nil {
			return nil, err
		}
		if t.engine == agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS {
			if ext != extRedis {
				return nil, fmt.Errorf("%w: %s is not a Redis backup", ErrBadRequest, key)
			}
			if l.opts.Suspend == nil {
				return nil, ErrSuspendUnavailable
			}
			return l.restoreRedis(ctx, store, key, spec)
		}
		job, err := restoreJob(t, ext)
		if err != nil {
			return nil, err
		}
		return l.restoreDump(ctx, store, key, spec, t, job)
	default:
		return nil, fmt.Errorf("%w: the subject has neither a volume nor a database", ErrBadRequest)
	}
}

// open downloads key, counting the bytes read, gunzipped when asked.
func open(ctx context.Context, store Store, key string, gunzip bool) (io.Reader, *countingReader, func(), error) {
	rc, err := store.Get(ctx, key)
	if err != nil {
		return nil, nil, nil, err
	}
	cr := &countingReader{r: rc}
	var r io.Reader = cr
	closeFn := func() { rc.Close() }
	if gunzip {
		gz, err := gzip.NewReader(cr)
		if err != nil {
			rc.Close()
			return nil, nil, nil, fmt.Errorf("%w: %s is not gzip: %v", ErrBadArchive, key, err)
		}
		r = gz
	}
	return r, cr, closeFn, nil
}

func (l *Local) restoreDump(ctx context.Context, store Store, key string, spec *agentv1.ServiceSpec, t dbTarget, job dbJob) (*agentv1.RestoreBackupResponse, error) {
	r, counter, closeFn, err := open(ctx, store, key, job.gzip)
	if err != nil {
		return nil, err
	}
	defer closeFn()
	tail := jobrun.NewTail(20, []string{t.password})
	res, err := l.opts.Docker.Run(ctx, helperSpec(spec, job, "restore-"+newSuffix(l.opts.Now())), jobrun.IO{Stdin: r, Stdout: tail, Stderr: tail})
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("the restore exited with code %d: %s", res.ExitCode, lastLine(tail))
	}
	return &agentv1.RestoreBackupResponse{RestoredBytes: uint64(counter.n)}, nil
}

// restoreVolume unpacks into a fresh sibling folder while the services
// still run, then swaps folders while every service that mounts it
// (serviceIDs: the subject and the compose members sharing the volume) is
// suspended, so the downtime is two renames, a failed download changes
// nothing, and no running container keeps the old folder mounted while it
// is deleted.
func (l *Local) restoreVolume(ctx context.Context, store Store, key string, serviceIDs []string, dir string) (*agentv1.RestoreBackupResponse, error) {
	r, counter, closeFn, err := open(ctx, store, key, false)
	if err != nil {
		return nil, err
	}
	defer closeFn()
	suffix := newSuffix(l.opts.Now())
	staging := dir + ".restore-" + suffix
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return nil, err
	}
	defer os.RemoveAll(staging)
	if err := extractArchive(ctx, r, staging); err != nil {
		return nil, err
	}
	resume, err := l.suspendAll(ctx, serviceIDs)
	if err != nil {
		return nil, fmt.Errorf("stopping the service: %w", err)
	}
	swapErr := swapDirs(dir, staging, dir+".before-restore-"+suffix)
	if err := resume(context.WithoutCancel(ctx)); err != nil {
		swapErr = errors.Join(swapErr, fmt.Errorf("starting the service: %w", err))
	}
	if swapErr != nil {
		return nil, swapErr
	}
	return &agentv1.RestoreBackupResponse{RestoredBytes: uint64(counter.n)}, nil
}

// swapDirs puts staging in place of dir and deletes the old content.
func swapDirs(dir, staging, old string) error {
	hadOld := true
	if err := os.Rename(dir, old); errors.Is(err, os.ErrNotExist) {
		hadOld = false
	} else if err != nil {
		return err
	}
	if err := os.Rename(staging, dir); err != nil {
		if hadOld {
			_ = os.Rename(old, dir)
		}
		return err
	}
	if hadOld {
		return os.RemoveAll(old)
	}
	return nil
}

// restoreRedis replaces dump.rdb in the data volume while Redis is
// stopped. An append-only folder would win over the RDB on start, so it
// is moved aside (kept, never deleted).
func (l *Local) restoreRedis(ctx context.Context, store Store, key string, spec *agentv1.ServiceSpec) (*agentv1.RestoreBackupResponse, error) {
	data, volume := "", ""
	for _, v := range spec.GetVolumes() {
		if v.GetContainerPath() == "/data" || data == "" {
			var err error
			if data, err = l.volumeDir(spec, v.GetName()); err != nil {
				return nil, err
			}
			volume = v.GetName()
		}
	}
	if data == "" {
		return nil, fmt.Errorf("%w: the Redis service has no data volume", ErrBadRequest)
	}
	r, counter, closeFn, err := open(ctx, store, key, true)
	if err != nil {
		return nil, err
	}
	defer closeFn()
	if err := os.MkdirAll(data, 0o755); err != nil {
		return nil, err
	}
	suffix := newSuffix(l.opts.Now())
	tmp := filepath.Join(data, "dump.rdb.restore-"+suffix)
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	_, cerr := io.Copy(f, r)
	// Through the open descriptor: the volume is container-writable, and
	// a chown by path would follow a symlink swapped in for tmp.
	if st, err := os.Stat(data); err == nil {
		if sys, ok := st.Sys().(*syscall.Stat_t); ok {
			_ = f.Chown(int(sys.Uid), int(sys.Gid))
		}
	}
	if err := errors.Join(cerr, f.Close()); err != nil {
		os.Remove(tmp)
		return nil, err
	}
	defer os.Remove(tmp)
	resume, err := l.suspendAll(ctx, l.mounters(spec, volume, false))
	if err != nil {
		return nil, fmt.Errorf("stopping the service: %w", err)
	}
	var swapErr error
	if aof := filepath.Join(data, "appendonlydir"); exists(aof) {
		swapErr = os.Rename(aof, aof+".before-restore-"+suffix)
	}
	if swapErr == nil {
		swapErr = os.Rename(tmp, filepath.Join(data, "dump.rdb"))
	}
	if err := resume(context.WithoutCancel(ctx)); err != nil {
		swapErr = errors.Join(swapErr, fmt.Errorf("starting the service: %w", err))
	}
	if swapErr != nil {
		return nil, swapErr
	}
	return &agentv1.RestoreBackupResponse{RestoredBytes: uint64(counter.n)}, nil
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

func newSuffix(t time.Time) string { return t.UTC().Format(timeLayout) }

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}
