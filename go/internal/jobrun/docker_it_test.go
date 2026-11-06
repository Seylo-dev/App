//go:build integration

package jobrun_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

const alpine = "alpine:3.22"

func spec(e *itest.Env, name string, cmd ...string) jobrun.Spec {
	return jobrun.Spec{
		Name:       name,
		Image:      alpine,
		Entrypoint: []string{"/bin/sh", "-c"},
		Cmd:        cmd,
		Labels:     jobrun.Labels(jobrun.Owner{ServiceID: e.Project + "s", ProjectID: e.Project, Kind: "app"}, jobrun.RoleCron, nil),
		Network:    e.Network,
	}
}

func TestRunStreamsStdioAndExitCode(t *testing.T) {
	e := itest.New(t)
	ctx := e.Ctx(5 * time.Minute)
	in := strings.Repeat("0123456789", 500000) // 5 MB through stdin and back
	var out, errOut bytes.Buffer
	res, err := e.D.Run(ctx, spec(e, e.Project+"-cat", `cat; echo bye >&2; exit 3`), jobrun.IO{Stdin: strings.NewReader(in), Stdout: &out, Stderr: &errOut})
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode != 3 || out.String() != in || strings.TrimSpace(errOut.String()) != "bye" {
		t.Fatalf("exit %d, %d bytes out (want %d), stderr %q", res.ExitCode, out.Len(), len(in), errOut.String())
	}
	if _, found, _ := e.D.Inspect(ctx, e.Project+"-cat"); found {
		t.Fatal("one-off container not removed")
	}
}

func TestRunTimeoutKillsAndRemoves(t *testing.T) {
	e := itest.New(t)
	ctx, cancel := context.WithTimeout(e.Ctx(5*time.Minute), 3*time.Second)
	defer cancel()
	start := time.Now()
	_ = e.D.EnsureImage(e.Ctx(5*time.Minute), alpine, nil)
	_, err := e.D.Run(ctx, spec(e, e.Project+"-sleep", "sleep 600"), jobrun.IO{})
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 60*time.Second {
		t.Fatalf("err = %v after %v", err, time.Since(start))
	}
	if _, found, _ := e.D.Inspect(e.Ctx(time.Minute), e.Project+"-sleep"); found {
		t.Fatal("timed-out container not removed")
	}
}

type failingWriter struct{ n int }

func (f *failingWriter) Write(p []byte) (int, error) {
	f.n += len(p)
	if f.n > 1<<20 {
		return 0, errors.New("upload broke")
	}
	return len(p), nil
}

func TestRunStopsWhenOutputFails(t *testing.T) {
	e := itest.New(t)
	start := time.Now()
	_, err := e.D.Run(e.Ctx(5*time.Minute), spec(e, e.Project+"-yes", "yes"), jobrun.IO{Stdout: &failingWriter{}})
	if err == nil || !strings.Contains(err.Error(), "upload broke") || time.Since(start) > 2*time.Minute {
		t.Fatalf("err = %v after %v", err, time.Since(start))
	}
}

func TestEnsureRunningRecreatesOnChange(t *testing.T) {
	e := itest.New(t)
	ctx := e.Ctx(5 * time.Minute)
	s := spec(e, e.Project+"-helper", "echo v1; sleep 600")
	s.KeepLogs = true
	c1, err := e.D.EnsureRunning(ctx, s)
	if err != nil || !c1.Running || !c1.IPs[e.Network].IsValid() {
		t.Fatalf("first = %+v, %v", c1, err)
	}
	if c1.Labels[docker.LabelManaged] != "true" || c1.Labels[jobrun.LabelSpecHash] == "" {
		t.Fatalf("labels = %v", c1.Labels)
	}
	same, err := e.D.EnsureRunning(ctx, s)
	if err != nil || same.ID != c1.ID {
		t.Fatalf("unchanged spec recreated: %v", err)
	}
	if err := e.D.Stop(ctx, c1.ID, time.Second); err != nil {
		t.Fatal(err)
	}
	restarted, err := e.D.EnsureRunning(ctx, s)
	if err != nil || restarted.ID != c1.ID || !restarted.Running {
		t.Fatalf("stopped helper not restarted in place: %+v %v", restarted, err)
	}
	s.Cmd = []string{"echo v2; sleep 600"}
	c2, err := e.D.EnsureRunning(ctx, s)
	if err != nil || c2.ID == c1.ID {
		t.Fatalf("changed spec not recreated: %v", err)
	}
	e.Eventually("v2 in logs", 30*time.Second, func() bool {
		rc, err := e.D.Logs(ctx, c2.ID, false)
		if err != nil {
			return false
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		return strings.Contains(string(b), "v2")
	})
}
