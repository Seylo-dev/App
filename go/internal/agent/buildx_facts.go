package agent

// Buildx facts (NodeFacts.buildx): whether `docker buildx version` works
// here, run the way builds run docker (internal/build: DOCKER_CONFIG under
// the builds folder, so a plugin only in root's ~/.docker does not count).
// The panel picks no automatic builds for a node that reports it missing
// and refuses it as an explicit build node, so a node with distro Docker
// and no plugin is not handed builds that would fail. Agents before 0.2.1
// report nothing, which the panel counts as installed.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
)

const (
	// buildxFactsEvery is how often the agent checks buildx again.
	buildxFactsEvery = 30 * time.Minute
	// buildxFactsMissingEvery is the pace while builds are on and buildx is
	// missing, so installing docker-buildx-plugin shows in the panel within
	// a minute instead of half an hour.
	buildxFactsMissingEvery = time.Minute
	// buildxCheckTimeout bounds one `docker buildx version`. A run that
	// times out teaches nothing, and the last answer stays.
	buildxCheckTimeout = 30 * time.Second
	// maxBuildxVersionLen caps BuildxInfo.version.
	maxBuildxVersionLen = 64
)

// BuildsOn is the agent's view of whether this node builds: the panel
// sends it builds (max_parallel_builds above 0, which it does when Can
// build is on) or config.yml's can_build asks for them. The buildx health
// check follows it, in the agent and in `seylo health`.
func BuildsOn(configCanBuild bool, settings *agentv1.NodeSettings) bool {
	return configCanBuild || settings.GetMaxParallelBuilds() > 0
}

// StoredSettings reads the NodeSettings of the last desired state the
// agent accepted (state/desired.pb), for commands that run beside the
// agent. It only reads: a missing or unreadable file gives nil, and the
// file is never moved or rewritten (the agent's own Load does that).
func StoredSettings(layout datadir.Layout) *agentv1.NodeSettings {
	data, err := os.ReadFile(filepath.Join(layout.StateDir(), "desired.pb"))
	if err != nil {
		return nil
	}
	desired := &agentv1.DesiredState{}
	if proto.Unmarshal(data, desired) != nil {
		return nil
	}
	return desired.GetSettings()
}

// feedSettings is the panel's current NodeSettings, nil without a feed (tests).
func feedSettings(d *Deps) *agentv1.NodeSettings {
	if d.Feed == nil {
		return nil
	}
	return d.Feed.Settings()
}

// buildxVersionFunc runs `docker buildx version` and returns what it printed.
type buildxVersionFunc func(ctx context.Context) (string, error)

// dockerBuildxVersion runs the real command with the builds' DOCKER_CONFIG.
func dockerBuildxVersion(configDir string) buildxVersionFunc {
	return func(ctx context.Context) (string, error) {
		cmd := exec.CommandContext(ctx, "docker", "buildx", "version")
		cmd.Env = append(os.Environ(), "DOCKER_CONFIG="+configDir, "DOCKER_CLI_HINTS=false")
		var out, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &stderr
		if err := cmd.Run(); err != nil {
			if msg := strings.TrimSpace(stderr.String()); msg != "" {
				return "", fmt.Errorf("%w: %s", err, msg)
			}
			return "", err
		}
		return out.String(), nil
	}
}

// buildxFacts keeps NodeFacts.buildx current.
type buildxFacts struct {
	facts   *Facts
	version buildxVersionFunc
	// buildsOn picks the faster pace while buildx is missing.
	buildsOn     func() bool
	every        time.Duration
	missingEvery time.Duration
	timeout      time.Duration
	logger       *slog.Logger
	recheck      chan struct{}
	// last is 0 before the first answer, then 1 (installed) or 2 (missing):
	// changes are logged once.
	last atomic.Int32
}

func newBuildxFacts(d *Deps, version buildxVersionFunc) *buildxFacts {
	return &buildxFacts{
		facts:        d.Facts,
		version:      version,
		buildsOn:     func() bool { return BuildsOn(d.Config.CanBuild, feedSettings(d)) },
		every:        buildxFactsEvery,
		missingEvery: buildxFactsMissingEvery,
		timeout:      buildxCheckTimeout,
		logger:       d.Logger.With("component", "buildx-facts"),
		recheck:      make(chan struct{}, 1),
	}
}

// Recheck asks for a check now, for example when the panel turns builds on.
func (b *buildxFacts) Recheck() {
	select {
	case b.recheck <- struct{}{}:
	default:
	}
}

// run checks at start, then every 30 minutes (every minute while builds
// are on and buildx is missing), and whenever Recheck asks.
func (b *buildxFacts) run(ctx context.Context) error {
	for {
		installed, known := b.check(ctx)
		if ctx.Err() != nil {
			return nil
		}
		wait := b.every
		if known && !installed && b.buildsOn() {
			wait = b.missingEvery
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		case <-b.recheck:
			timer.Stop()
		}
	}
}

// check runs the command once and stores the answer in the facts. known is
// false when the run taught nothing (it timed out or the agent stops); the
// facts then keep the last answer.
func (b *buildxFacts) check(ctx context.Context) (installed, known bool) {
	runCtx, cancel := context.WithTimeout(ctx, b.timeout)
	defer cancel()
	out, err := b.version(runCtx)
	if ctx.Err() != nil {
		return false, false
	}
	if err != nil && errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		b.logger.Warn("docker buildx version did not answer in time; keeping the last result", "timeout", b.timeout)
		return false, false
	}
	info := &agentv1.BuildxInfo{Installed: err == nil}
	if err == nil {
		info.Version = buildxVersion(out)
	}
	b.facts.Update(func(f *agentv1.NodeFacts) { f.Buildx = info })
	b.logChange(info, err)
	return info.GetInstalled(), true
}

func (b *buildxFacts) logChange(info *agentv1.BuildxInfo, err error) {
	now := int32(2)
	if info.GetInstalled() {
		now = 1
	}
	if b.last.Swap(now) == now {
		return
	}
	if info.GetInstalled() {
		b.logger.Info("docker buildx found", "version", info.GetVersion())
		return
	}
	b.logger.Warn("docker buildx is not installed: the panel picks no builds for this node until it is (install docker-buildx-plugin)", "err", err)
}

// buildxVersion takes the version from `docker buildx version`, which
// prints "github.com/docker/buildx v0.29.1 <commit>" (distro packages print
// "github.com/docker/buildx 0.13.1+ds1-3 <commit>"). Output it does not
// recognise is kept whole, cut to a short printable string.
func buildxVersion(out string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(out), "\n")
	version := strings.TrimSpace(line)
	if fields := strings.Fields(line); len(fields) >= 2 {
		version = fields[1]
	}
	var b strings.Builder
	for _, r := range version {
		if b.Len() >= maxBuildxVersionLen {
			break
		}
		switch {
		case r >= '!' && r <= '~':
			b.WriteRune(r)
		case r == ' ' || r == '\t':
			b.WriteByte(' ')
		}
	}
	return strings.TrimSpace(b.String())
}
