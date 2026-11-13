//go:build integration

package jobrun_test

import (
	"bytes"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/jobrun"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

// A cron run gets the service's init process: Docker's init as PID 1 with
// Auto (and On), none for a spec from before 0.2.15 or Off.
func TestRunInitProcess(t *testing.T) {
	e := itest.New(t)
	for _, c := range []struct {
		mode agentv1.InitMode
		pid1 string
	}{
		{agentv1.InitMode_INIT_MODE_AUTO, "docker-init"},
		{agentv1.InitMode_INIT_MODE_ON, "docker-init"},
		{agentv1.InitMode_INIT_MODE_UNSPECIFIED, "cat"},
		{agentv1.InitMode_INIT_MODE_OFF, "cat"},
	} {
		s := spec(e, e.Project+"-init-"+strings.ToLower(strings.TrimPrefix(c.mode.String(), "INIT_MODE_")), "exec cat /proc/1/comm")
		s.Init = c.mode
		var out bytes.Buffer
		res, err := e.D.Run(e.Ctx(5*time.Minute), s, jobrun.IO{Stdout: &out})
		if err != nil || res.ExitCode != 0 {
			t.Fatalf("%v: exit %d, %v", c.mode, res.ExitCode, err)
		}
		if got := strings.TrimSpace(out.String()); got != c.pid1 {
			t.Errorf("%v: PID 1 is %q, want %q", c.mode, got, c.pid1)
		}
	}
}
