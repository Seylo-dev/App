//go:build integration

package cron_test

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/cron"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

// A cron job runs in a one-off container from the service's image, with
// its env, volumes and network, and reports its output and exit code.
func TestCronRunsInOneOffContainer(t *testing.T) {
	e := itest.New(t)
	ctx, cancel := context.WithCancel(e.Ctx(10 * time.Minute))
	defer cancel()

	// A service the job can reach on the project network by name.
	web := e.Spec("web", "web", "busybox:1.37")
	web.Container = &agentv1.ContainerConfig{Command: []string{"sh", "-c", "mkdir -p /www && echo pong > /www/index.html && httpd -f -p 8080 -h /www"}}
	e.StartService(web)

	app := e.Spec("app", "app", "alpine:3.22")
	app.Env = []*agentv1.EnvVar{{Name: "GREETING", Value: "hello"}, {Name: "TOKEN", Value: "s3cr3t-token", Secret: true}}
	app.Volumes = []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/data"}}
	app.CronJobs = []*agentv1.CronJob{
		{Id: "ok", Schedule: "@daily", Command: []string{"sh", "-c", `echo "$GREETING $TOKEN"; for i in 1 2 3 4 5 6 7 8 9 10; do wget -qO- http://web:8080/ 2>/dev/null && break; sleep 1; done; date > /data/ran; echo done`}},
		{Id: "fail", Schedule: "@daily", Command: []string{"sh", "-c", "echo broken >&2; exit 7"}},
		{Id: "slow", Schedule: "@daily", Command: []string{"sleep", "600"}, Timeout: durationpb.New(3 * time.Second)},
	}
	vol, _ := e.Layout.ServiceVolume(app.GetId(), "data")

	s := cron.NewLocal(cron.Options{Runner: e.D, Layout: e.Layout})
	reports := make(chan *agentv1.CronRun, 8)
	done := make(chan struct{})
	go func() { _ = s.Run(ctx, func(r *agentv1.CronRun) { reports <- r }); close(done) }()
	if err := s.Sync([]*agentv1.ServiceSpec{app}); err != nil {
		t.Fatal(err)
	}
	e.Eventually("scheduler running", 10*time.Second, func() bool {
		_, err := s.RunNow(ctx, &agentv1.RunCronNowRequest{ServiceId: app.GetId(), CronJobId: "ok", RunId: "run-ok"})
		return err == nil
	})
	wait := func(job string) *agentv1.CronRun {
		t.Helper()
		select {
		case r := <-reports:
			if r.GetCronJobId() != job {
				t.Fatalf("got report for %q, want %q: %v", r.GetCronJobId(), job, r)
			}
			return r
		case <-time.After(5 * time.Minute):
			t.Fatalf("no report for %s", job)
			return nil
		}
	}
	r := wait("ok")
	if r.GetResult() != agentv1.CronRunResult_CRON_RUN_RESULT_SUCCEEDED || r.GetRunId() != "run-ok" || !r.GetManual() {
		t.Fatalf("ok run = %v", r)
	}
	if !slices.Equal(r.GetLastLines(), []string{"hello [redacted]", "pong", "done"}) {
		t.Fatalf("ok output = %q", r.GetLastLines())
	}
	if b, err := os.ReadFile(filepath.Join(vol, "ran")); err != nil || len(b) == 0 {
		t.Fatalf("job did not write the service volume: %v", err)
	}

	if _, err := s.RunNow(ctx, &agentv1.RunCronNowRequest{ServiceId: app.GetId(), CronJobId: "fail"}); err != nil {
		t.Fatal(err)
	}
	r = wait("fail")
	if r.GetResult() != agentv1.CronRunResult_CRON_RUN_RESULT_FAILED || r.GetExitCode() != 7 || !slices.Contains(r.GetLastLines(), "broken") {
		t.Fatalf("fail run = %v", r)
	}

	if _, err := s.RunNow(ctx, &agentv1.RunCronNowRequest{ServiceId: app.GetId(), CronJobId: "slow"}); err != nil {
		t.Fatal(err)
	}
	// While it runs, a second one is skipped (forbid is the default).
	time.Sleep(time.Second)
	if resp, err := s.RunNow(ctx, &agentv1.RunCronNowRequest{ServiceId: app.GetId(), CronJobId: "slow"}); err != nil || resp.GetStarted() {
		t.Fatalf("second slow run = %v, %v", resp, err)
	}
	if r = wait("slow"); r.GetResult() != agentv1.CronRunResult_CRON_RUN_RESULT_SKIPPED {
		t.Fatalf("skipped run = %v", r)
	}
	r = wait("slow")
	if r.GetResult() != agentv1.CronRunResult_CRON_RUN_RESULT_TIMED_OUT || !strings.Contains(strings.Join(r.GetLastLines(), " "), "longer than 3s") {
		t.Fatalf("slow run = %v", r)
	}
	// No run container is left behind.
	cs, err := e.D.ListContainers(ctx, map[string]string{docker.LabelService: app.GetId()})
	if err != nil || len(cs) != 0 {
		t.Fatalf("leftover run containers: %v %v", cs, err)
	}
	cancel()
	<-done
}
