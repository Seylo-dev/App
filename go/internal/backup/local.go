package backup

import (
	"compress/gzip"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/dbengine"
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
	// OpenStore opens a destination; nil means OpenSigned with Signer for a
	// destination without keys (signing_id set), else OpenS3.
	OpenStore func(*agentv1.BackupDestination) (Store, error)
	// Signer presigns the requests of keyless destinations (the panel
	// connection); nil refuses them.
	Signer Signer
	Logger *slog.Logger
	Now    func() time.Time
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
		signer := opts.Signer
		opts.OpenStore = func(d *agentv1.BackupDestination) (Store, error) {
			if d.GetSigningId() != "" {
				return OpenSigned(signer, d)
			}
			return OpenS3(d)
		}
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
		if err := checkSelections(t.engine, w.Database.GetSelections()); err != nil {
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

// volumeOwner is the service whose folder holds a volume the service
// mounts.
func volumeOwner(spec *agentv1.ServiceSpec, name string) (string, error) {
	for _, v := range spec.GetVolumes() {
		if v.GetName() != name {
			continue
		}
		if owner := v.GetOwnerServiceId(); owner != "" {
			return owner, nil
		}
		return spec.GetId(), nil
	}
	return "", fmt.Errorf("%w: service %s has no volume %q", ErrBadRequest, spec.GetId(), name)
}

// volumeDir is the folder of a volume the service mounts.
func (l *Local) volumeDir(spec *agentv1.ServiceSpec, name string) (string, error) {
	owner, err := volumeOwner(spec, name)
	if err != nil {
		return "", err
	}
	return l.opts.Layout.ServiceVolume(owner, name)
}

// makeVolumeDir is volumeDir, created (with the service folder private to
// root, datadir.MakeServiceVolume) when it is not there yet.
func (l *Local) makeVolumeDir(spec *agentv1.ServiceSpec, name string) (string, error) {
	owner, err := volumeOwner(spec, name)
	if err != nil {
		return "", err
	}
	return l.opts.Layout.MakeServiceVolume(owner, name)
}

// backup produces the archive or dump and streams it to the store.
func (l *Local) backup(ctx context.Context, p *backupPlan, res *agentv1.BackupResult) error {
	started := l.opts.Now()
	progress := newProgress(l.opts.Progress, p.req, 2*time.Second)

	var ext string
	var produce func(w io.Writer) error
	if p.db != nil {
		plan, err := l.planDump(ctx, p, res)
		if err != nil {
			return err
		}
		ext = plan.ext
		produce = func(w io.Writer) error { return l.runPlan(ctx, p, plan, w) }
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
				if _, err := l.makeVolumeDir(p.spec, p.volName); err != nil {
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

// planDump decides what a database backup dumps and records what it
// holds in res. With selections the server is listed first and the
// chosen names matched against it (resolve): a failed listing or nothing
// left fails the backup. Without, the dump is the one from before
// selections (everything, or the one database the request names) and the
// listing only measures it: when it fails, the backup still runs, with a
// warning.
func (l *Local) planDump(ctx context.Context, p *backupPlan, res *agentv1.BackupResult) (dumpPlan, error) {
	t := *p.db
	run := p.req.GetRunId()
	if sels := p.req.GetSubject().GetDatabase().GetSelections(); len(sels) > 0 {
		live, err := l.inspect(ctx, p.spec, t, "measure-"+run)
		if err != nil {
			return dumpPlan{}, fmt.Errorf("listing the databases before the backup: %w", err)
		}
		picked, warnings, err := resolve(t.engine, sels, live)
		res.Warnings = warnings
		if err != nil {
			return dumpPlan{}, err
		}
		plan, err := selectionPlan(t, picked)
		if err != nil {
			return dumpPlan{}, err
		}
		res.Contents = selectionContents(picked)
		return plan, nil
	}
	job, err := dumpJob(t, run)
	if err != nil {
		return dumpPlan{}, err
	}
	if selectable(t.engine) {
		live, err := l.inspect(ctx, p.spec, t, "measure-"+run)
		switch {
		case err != nil:
			res.Warnings = append(res.Warnings, "What the backup holds could not be measured: "+err.Error())
			if t.database == "" {
				res.Contents = &agentv1.BackupContents{WholeServer: true}
			}
		case t.database == "":
			res.Contents = wholeServerContents(live)
		default:
			res.Contents = singleContents(live, t.database)
		}
	}
	return dumpPlan{jobs: []dbJob{job}, ext: job.ext}, nil
}

// runPlan writes the plan's dump to w: one job's output, or each job's
// framed into a bundle.
func (l *Local) runPlan(ctx context.Context, p *backupPlan, plan dumpPlan, w io.Writer) error {
	run := p.req.GetRunId()
	if plan.bundle == nil {
		return l.runDump(ctx, p, plan.jobs[0], w, "backup-"+run)
	}
	bw, err := newBundleWriter(w, *plan.bundle)
	if err != nil {
		return err
	}
	for i, job := range plan.jobs {
		mw, err := bw.member()
		if err != nil {
			return err
		}
		if err := l.runDump(ctx, p, job, mw, fmt.Sprintf("backup-%s-%d", run, i+1)); err != nil {
			return fmt.Errorf("dumping %q: %w", plan.bundle.Members[i].Database, err)
		}
		if err := bw.endMember(); err != nil {
			return err
		}
	}
	return bw.close()
}

// runDump runs the dump command in a helper container named what and
// writes its stdout (gzipped when the format needs it) to w.
func (l *Local) runDump(ctx context.Context, p *backupPlan, job dbJob, w io.Writer, what string) error {
	errTail := jobrun.NewTail(20, []string{p.db.password})
	out := w
	var gz *gzip.Writer
	if job.gzip {
		gz = gzip.NewWriter(w)
		out = gz
	}
	helper, err := l.helperSpec(p.spec, job, what)
	if err != nil {
		return err
	}
	res, err := l.opts.Docker.Run(ctx, helper, jobrun.IO{Stdout: out, Stderr: errTail})
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

// restoreLine is lastLine of a restore, except that pg_restore ends a
// failed statement with "Command was: <the statement>": the line that
// says why (its "ERROR:" line) comes before it.
func restoreLine(t *jobrun.Tail) string {
	last := lastLine(t)
	if !strings.HasPrefix(last, "Command was:") {
		return last
	}
	lines := t.Lines()
	for i := len(lines) - 1; i >= 0; i-- {
		if s := strings.TrimSpace(lines[i]); strings.Contains(s, "ERROR:") {
			return s
		}
	}
	return last
}

// helperSpec is the dump or restore container: the database's own image
// on its project network, with the service's volumes when the job needs
// the files the server writes.
func (l *Local) helperSpec(spec *agentv1.ServiceSpec, job dbJob, what string) (jobrun.Spec, error) {
	s := jobrun.Spec{
		Name:       jobrun.HelperName(spec.GetId(), what),
		Image:      jobrun.ImageRef(spec.GetImage()),
		Auth:       spec.GetImage().GetAuth(),
		Entrypoint: []string{"/bin/sh", "-c"},
		Cmd:        helperCmd(job),
		Env:        job.env,
		Labels:     jobrun.Labels(jobrun.OwnerOf(spec), jobrun.RoleBackup, map[string]string{jobrun.LabelRun: what}),
		Network:    jobrun.ProjectNetwork(spec),
	}
	if job.volumes {
		binds, err := jobrun.VolumeBinds(l.opts.Layout, spec)
		if err != nil {
			return jobrun.Spec{}, err
		}
		s.Binds = binds
	}
	return s, nil
}

// helperCmd is the helper's command: the script, then its arguments
// ("$0" is a name, "$@" the arguments).
func helperCmd(job dbJob) []string {
	if len(job.args) == 0 {
		return []string{job.script}
	}
	return append([]string{job.script, "seylo-backup"}, job.args...)
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
		if _, err := l.volumeDir(spec, w.Volume); err != nil {
			return nil, err
		}
		if l.opts.Suspend == nil {
			return nil, ErrSuspendUnavailable
		}
		// Made first, so the staging folder next to it is inside a service
		// folder only root may enter.
		dir, err := l.makeVolumeDir(spec, w.Volume)
		if err != nil {
			return nil, err
		}
		return l.restoreVolume(ctx, store, key, l.mounters(spec, w.Volume, false), dir)
	case *agentv1.BackupSubject_Database:
		sels := w.Database.GetSelections()
		database := w.Database.GetDatabase()
		if database == "" && len(sels) == 1 {
			database = sels[0].GetDatabase()
		}
		if database == "" && ext == extPgCustom {
			database = spec.GetDatabase().GetCredentials().GetDatabase()
		}
		t, err := targetOf(spec, database)
		if err != nil {
			return nil, err
		}
		if err := checkSelections(t.engine, sels); err != nil {
			return nil, err
		}
		if dbengine.RedisLike(t.engine) {
			if ext != extRedis {
				return nil, fmt.Errorf("%w: %s is not a Redis backup", ErrBadRequest, key)
			}
			if l.opts.Suspend == nil {
				return nil, ErrSuspendUnavailable
			}
			return l.restoreRedis(ctx, store, key, spec)
		}
		if ext == extBundle {
			return l.restoreBundle(ctx, store, key, spec, t)
		}
		run := restoreRun(l.opts.Now())
		job, err := restoreJob(t, ext, run)
		if err != nil {
			return nil, err
		}
		if t.engine == agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO {
			// What the backup holds replaces what is there: mongorestore
			// --drop drops only the collections it restores.
			job.args = restoreNamespaces(sels)
		}
		return l.restoreDump(ctx, store, key, spec, t, job, run)
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

// restoreRun names one restore's helper container and the files it keeps
// in the data volume (ClickHouse's zip, the renamed databases): the time
// plus random characters, so two restores in the same second (a retry
// right after a failure) never share a name.
func restoreRun(now time.Time) string {
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return newSuffix(now) + "-" + hex.EncodeToString(b)
}

func (l *Local) restoreDump(ctx context.Context, store Store, key string, spec *agentv1.ServiceSpec, t dbTarget, job dbJob, run string) (*agentv1.RestoreBackupResponse, error) {
	r, counter, closeFn, err := open(ctx, store, key, job.gzip)
	if err != nil {
		return nil, err
	}
	defer closeFn()
	tail := jobrun.NewTail(20, []string{t.password})
	helper, err := l.helperSpec(spec, job, "restore-"+run)
	if err != nil {
		return nil, err
	}
	res, err := l.opts.Docker.Run(ctx, helper, jobrun.IO{Stdin: r, Stdout: tail, Stderr: tail})
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("the restore exited with code %d: %s", res.ExitCode, restoreLine(tail))
	}
	return &agentv1.RestoreBackupResponse{RestoredBytes: uint64(counter.n)}, nil
}

// restoreBundle restores each database of a bundle in turn, each with its
// own restore (for Postgres one transaction per database). A failure
// stops there and says which databases were restored before it.
func (l *Local) restoreBundle(ctx context.Context, store Store, key string, spec *agentv1.ServiceSpec, t dbTarget) (*agentv1.RestoreBackupResponse, error) {
	engine := map[agentv1.DatabaseEngine]string{
		agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES: "postgres",
		agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:    "mongo",
	}[t.engine]
	if engine == "" {
		return nil, fmt.Errorf("%w: a bundle cannot be restored into %v", ErrBadRequest, t.engine)
	}
	r, counter, closeFn, err := open(ctx, store, key, false)
	if err != nil {
		return nil, err
	}
	defer closeFn()
	br, err := openBundle(r)
	if err != nil {
		return nil, err
	}
	if br.manifest.Engine != engine {
		return nil, fmt.Errorf("%w: the bundle holds %s databases, not %s", ErrBadRequest, br.manifest.Engine, engine)
	}
	var done []string
	for {
		m, mr, err := br.nextMember()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, bundleFailure(done, "", br.manifest, err)
		}
		mt := t
		mt.database = m.Database
		run := restoreRun(l.opts.Now())
		job, err := restoreJob(mt, m.Format, run)
		if err != nil {
			return nil, bundleFailure(done, m.Database, br.manifest, err)
		}
		if t.engine == agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO {
			job.args = restoreNamespaces([]*agentv1.DatabaseSelection{{Database: m.Database}})
		}
		if err := l.restoreMember(ctx, spec, mt, job, run, mr, br); err != nil {
			return nil, bundleFailure(done, m.Database, br.manifest, err)
		}
		done = append(done, m.Database)
	}
	return &agentv1.RestoreBackupResponse{RestoredBytes: uint64(counter.n)}, nil
}

// bundleFailure says what a failed bundle restore did.
func bundleFailure(done []string, failed string, m bundleManifest, err error) error {
	what := "reading the bundle failed"
	if failed != "" {
		what = fmt.Sprintf("restoring %q failed", failed)
	}
	restored := "nothing was restored"
	if len(done) > 0 {
		restored = "restored before it: " + quoteList(done)
	}
	next := len(done)
	if failed != "" {
		next++
	}
	var left []string
	for _, mem := range m.Members[min(next, len(m.Members)):] {
		left = append(left, mem.Database)
	}
	if len(left) > 0 {
		restored += "; not restored: " + quoteList(left)
	}
	return fmt.Errorf("%s (%s): %w", what, restored, err)
}

// errReader remembers the first read error of r.
type errReader struct {
	r   io.Reader
	err error
}

func (e *errReader) Read(p []byte) (int, error) {
	n, err := e.r.Read(p)
	if err != nil && !errors.Is(err, io.EOF) && e.err == nil {
		e.err = err
	}
	return n, err
}

// restoreMember runs one bundle member's restore with the member's bytes
// on stdin. They go through a pipe this function owns: once the helper is
// done, the copy into it is stopped and waited for, and what the tool did
// not read is drained here, so nothing else reads the bundle while the
// next member starts.
func (l *Local) restoreMember(ctx context.Context, spec *agentv1.ServiceSpec, t dbTarget, job dbJob, run string, member io.Reader, br *bundleReader) error {
	src := &errReader{r: member}
	pr, pw := io.Pipe()
	copied := make(chan struct{})
	go func() {
		defer close(copied)
		_, err := io.Copy(pw, src)
		pw.CloseWithError(err)
	}()
	tail := jobrun.NewTail(20, []string{t.password})
	helper, err := l.helperSpec(spec, job, "restore-"+run)
	if err != nil {
		pr.Close()
		<-copied
		return err
	}
	res, err := l.opts.Docker.Run(ctx, helper, jobrun.IO{Stdin: pr, Stdout: tail, Stderr: tail})
	pr.CloseWithError(errors.New("the restore finished"))
	<-copied
	if err != nil {
		return err
	}
	if src.err != nil {
		return src.err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("the restore exited with code %d: %s", res.ExitCode, restoreLine(tail))
	}
	return br.drain()
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

// restoreRedis replaces dump.rdb in the data volume while the server (Redis,
// Valkey, KeyDB or Dragonfly) is stopped. With append-only on (the panel
// runs Redis, Valkey and KeyDB with --appendonly yes) the server loads only
// its append-only files and starts empty when they are missing, so the
// existing ones (the appendonlydir folder of Redis 7+ and Valkey, KeyDB's
// single appendonly.aof) are moved aside as <name>.before-restore-<time>
// (the undo for this restore; the copies of earlier restores are deleted
// once this one is in place, so the volume holds at most one) and the RDB
// is also written as appendonly.aof: a file that starts with an RDB
// preamble. KeyDB loads it as is; Redis 7+ and Valkey take it as an AOF
// from before 7.0 and move it into a new appendonlydir. Dragonfly has no
// append-only file and loads dump.rdb.
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
	if _, err := l.makeVolumeDir(spec, volume); err != nil {
		return nil, err
	}
	suffix := newSuffix(l.opts.Now())
	tmp := filepath.Join(data, "dump.rdb.restore-"+suffix)
	paths := []string{tmp}
	aofCopy := ""
	if spec.GetDatabase().GetEngine() != agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY {
		aofCopy = filepath.Join(data, "appendonly.aof.restore-"+suffix)
		paths = append(paths, aofCopy)
	}
	if err := writeRDB(paths, data, r); err != nil {
		return nil, err
	}
	for _, p := range paths {
		defer os.Remove(p)
	}
	resume, err := l.suspendAll(ctx, l.mounters(spec, volume, false))
	if err != nil {
		return nil, fmt.Errorf("stopping the service: %w", err)
	}
	var swapErr error
	for _, name := range []string{"appendonlydir", "appendonly.aof"} {
		if aof := filepath.Join(data, name); swapErr == nil && exists(aof) {
			swapErr = os.Rename(aof, aof+".before-restore-"+suffix)
		}
	}
	if swapErr == nil && aofCopy != "" {
		swapErr = os.Rename(aofCopy, filepath.Join(data, "appendonly.aof"))
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
	if err := pruneRedisUndo(data, suffix); err != nil {
		l.log.Warn("deleting the append-only copies of earlier restores", "service_id", spec.GetId(), "err", err)
	}
	return &agentv1.RestoreBackupResponse{RestoredBytes: uint64(counter.n)}, nil
}

// redisUndo matches the append-only files an RDB restore moved aside.
var redisUndo = regexp.MustCompile(`^(appendonlydir|appendonly\.aof)\.before-restore-(\d{8}T\d{6}Z)$`)

// pruneRedisUndo deletes the append-only copies earlier restores moved
// aside in data, keeping the ones of the restore at keep. The folder is
// container-writable: os.RemoveAll unlinks a planted symlink instead of
// following it (it walks with openat and O_NOFOLLOW).
func pruneRedisUndo(data, keep string) error {
	entries, err := os.ReadDir(data)
	if err != nil {
		return err
	}
	var errs []error
	for _, e := range entries {
		m := redisUndo.FindStringSubmatch(e.Name())
		if m == nil || m[2] == keep {
			continue
		}
		if err := os.RemoveAll(filepath.Join(data, e.Name())); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// rdbEOFMarkLen is the length of the hex marker a diskless replication
// stream ends with. redis-cli --rdb - cannot truncate stdout, so RDBs it
// dumped from a diskless master (Redis 7+ and Valkey by default) keep the
// marker after the RDB's EOF opcode (0xFF) and 8-byte checksum. A dump.rdb
// load stops at the EOF opcode, but an append-only file would read the
// marker as a command and refuse to start.
const rdbEOFMarkLen = 40

// rdbTail is how many trailing bytes rdbHasEOFMark looks at.
const rdbTail = 1 + 8 + rdbEOFMarkLen

func rdbHasEOFMark(tail []byte) bool {
	if len(tail) != rdbTail || tail[0] != 0xFF {
		return false
	}
	for _, c := range tail[9:] {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// tailWriter keeps the last bytes written to it.
type tailWriter struct {
	buf []byte
	n   int64
}

func (t *tailWriter) Write(p []byte) (int, error) {
	t.n += int64(len(p))
	t.buf = append(t.buf, p...)
	if len(t.buf) > rdbTail {
		t.buf = append(t.buf[:0], t.buf[len(t.buf)-rdbTail:]...)
	}
	return len(p), nil
}

// writeRDB writes the RDB in r to new files at paths (never through an
// existing name, and never opened again by name: the folder is
// container-writable) owned like dir, so the server that runs as dir's
// owner can read and replace them, without a trailing diskless marker. On
// error nothing is left behind.
func writeRDB(paths []string, dir string, r io.Reader) (err error) {
	var files []*os.File
	defer func() {
		for _, f := range files {
			if cerr := f.Close(); err == nil {
				err = cerr
			}
		}
		if err != nil {
			for _, p := range paths {
				os.Remove(p)
			}
		}
	}()
	tail := &tailWriter{}
	ws := []io.Writer{tail}
	for _, p := range paths {
		f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err != nil {
			return err
		}
		files = append(files, f)
		ws = append(ws, f)
	}
	if _, err := io.Copy(io.MultiWriter(ws...), r); err != nil {
		return err
	}
	if rdbHasEOFMark(tail.buf) {
		for _, f := range files {
			if err := f.Truncate(tail.n - rdbEOFMarkLen); err != nil {
				return err
			}
		}
	}
	// Through the open descriptors: a chown by path would follow a symlink
	// swapped in for it.
	if st, serr := os.Stat(dir); serr == nil {
		if sys, ok := st.Sys().(*syscall.Stat_t); ok {
			for _, f := range files {
				_ = f.Chown(int(sys.Uid), int(sys.Gid))
			}
		}
	}
	return nil
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
