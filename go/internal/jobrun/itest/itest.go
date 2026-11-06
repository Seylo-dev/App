//go:build integration

// Package itest is shared setup for the jobs packages' Docker integration
// tests, which run in the test VM (scripts/dev/vm-gotest.sh). Every resource
// a test makes lives in one project with a unique id, and is removed at the
// end.
package itest

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/client"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

// Env is one test's Docker world.
type Env struct {
	T       *testing.T
	D       *jobrun.Docker
	Project string
	Network string
	Layout  datadir.Layout
}

// New skips unless SEYLO_IT=1, then creates a unique project network and
// registers cleanup of everything labeled with that project.
func New(t *testing.T) *Env {
	t.Helper()
	if os.Getenv("SEYLO_IT") != "1" {
		t.Skip("integration test: run with scripts/dev/vm-gotest.sh")
	}
	d, err := jobrun.Connect(nil)
	if err != nil {
		t.Fatal(err)
	}
	var b [4]byte
	_, _ = rand.Read(b[:])
	e := &Env{T: t, D: d, Project: "jbit" + hex.EncodeToString(b[:]), Layout: datadir.New(t.TempDir())}
	e.Network = docker.ProjectNetwork(e.Project)
	ctx := context.Background()
	if _, err := d.Client().NetworkCreate(ctx, e.Network, client.NetworkCreateOptions{Driver: "bridge",
		Labels: map[string]string{docker.LabelManaged: "true", docker.LabelProject: e.Project}}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.cleanup)
	return e
}

func (e *Env) cleanup() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cs, _ := e.D.ListContainers(ctx, map[string]string{docker.LabelProject: e.Project})
	for _, c := range cs {
		_ = e.D.Remove(ctx, c.ID)
	}
	_, _ = e.D.Client().NetworkRemove(ctx, e.Network, client.NetworkRemoveOptions{})
}

// With returns the same world for a subtest, so failures go to t.
func (e *Env) With(t *testing.T) *Env {
	c := *e
	c.T = t
	return &c
}

// Pull fetches images up front, retrying registry hiccups.
func (e *Env) Pull(images ...string) {
	e.T.Helper()
	for _, img := range images {
		var err error
		for attempt := 0; attempt < 4; attempt++ {
			if err = e.D.EnsureImage(e.Ctx(10*time.Minute), img, nil); err == nil {
				break
			}
			time.Sleep(time.Duration(attempt+1) * 5 * time.Second)
		}
		if err != nil {
			e.T.Fatalf("pulling %s: %v", img, err)
		}
	}
}

// Ctx is a context that ends with the test (or after limit).
func (e *Env) Ctx(limit time.Duration) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	e.T.Cleanup(cancel)
	return ctx
}

// Spec is a service spec in the test project.
func (e *Env) Spec(id, name, image string) *agentv1.ServiceSpec {
	return &agentv1.ServiceSpec{Id: e.Project + id, ProjectId: e.Project, Name: name, Generation: 1,
		Kind: agentv1.ServiceKind_SERVICE_KIND_APP, Image: &agentv1.ImageRef{Reference: image}}
}

// StartService runs spec the way reconcile would: one container with the
// service labels (no role), its volumes, env and the name as network alias.
func (e *Env) StartService(spec *agentv1.ServiceSpec) jobrun.Container {
	e.T.Helper()
	binds, err := jobrun.VolumeBinds(e.Layout, spec)
	if err != nil {
		e.T.Fatal(err)
	}
	labels := docker.InstanceLabels{ServiceID: spec.GetId(), ProjectID: spec.GetProjectId(), Kind: jobrun.KindLabel(spec.GetKind()), Generation: spec.GetGeneration()}.Map()
	c, err := e.D.EnsureRunning(e.Ctx(5*time.Minute), jobrun.Spec{
		Name: docker.ContainerName(spec.GetId(), spec.GetGeneration(), 0), Image: jobrun.ImageRef(spec.GetImage()),
		Cmd: spec.GetContainer().GetCommand(), Env: jobrun.Env(spec), Labels: labels, Binds: binds,
		Network: e.Network, Aliases: []string{spec.GetName()}, KeepLogs: true,
	})
	if err != nil {
		e.T.Fatal(err)
	}
	return c
}

// Exec runs argv inside a container and returns combined output and exit
// code.
func (e *Env) Exec(container string, argv, env []string) (string, int) {
	e.T.Helper()
	ctx := e.Ctx(2 * time.Minute)
	cli := e.D.Client()
	ex, err := cli.ExecCreate(ctx, container, client.ExecCreateOptions{Cmd: argv, Env: env, AttachStdout: true, AttachStderr: true})
	if err != nil {
		e.T.Fatal(err)
	}
	att, err := cli.ExecAttach(ctx, ex.ID, client.ExecAttachOptions{})
	if err != nil {
		e.T.Fatal(err)
	}
	defer att.Close()
	var out bytes.Buffer
	_, _ = stdcopy.StdCopy(&out, &out, att.Reader)
	ins, err := cli.ExecInspect(ctx, ex.ID, client.ExecInspectOptions{})
	if err != nil {
		e.T.Fatal(err)
	}
	return strings.TrimSpace(out.String()), ins.ExitCode
}

// Eventually retries fn until it returns true or limit passes.
func (e *Env) Eventually(desc string, limit time.Duration, fn func() bool) {
	e.T.Helper()
	deadline := time.Now().Add(limit)
	for !fn() {
		if time.Now().After(deadline) {
			e.T.Fatalf("timed out waiting for %s", desc)
		}
		time.Sleep(time.Second)
	}
}
