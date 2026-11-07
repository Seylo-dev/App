package update

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// releaseMirror serves one signed manifest as that release and as
// "latest", like GitHub releases, for CheckOnConnect and UpdateToLatest.
func releaseMirror(t *testing.T, f *agentFixture, version string) {
	t.Helper()
	data := marshal(t, testManifest(version, f.binary, f.server.URL))
	sig := f.key.sign(data)
	mirror := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/manifest.json"):
			_, _ = w.Write(data)
		case strings.HasSuffix(r.URL.Path, "/manifest.json.minisig"):
			_, _ = w.Write(sig)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(mirror.Close)
	old := TestReleaseBaseURL
	TestReleaseBaseURL = mirror.URL + "/releases"
	t.Cleanup(func() { TestReleaseBaseURL = old })
}

// clock is a settable Now for updaters made across "restarts".
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

func (f *agentFixture) updaterAt(current string, c *clock) *AgentUpdater {
	f.t.Helper()
	u := f.updater(current)
	u.opts.Now = c.Now
	return u
}

func quietRun(context.Context, io.Writer, string, ...string) error { return nil }

// A release the guard rolled back is not installed again on the next
// connect (agentio-1: it was, every ~4 minutes, forever): automatic
// updates wait an hour after the first rollback and a day after the
// second, across agent restarts, and the node raises UPDATE_FAILED.
func TestRolledBackReleaseWaits(t *testing.T) {
	f := newAgentFixture(t, "1.2.0")
	releaseMirror(t, f, "1.2.0")
	c := &clock{now: time.Now()}
	ctx := context.Background()
	installs := func() int {
		f.system.mu.Lock()
		defer f.system.mu.Unlock()
		return len(f.system.armed)
	}
	rollback := func() {
		t.Helper()
		<-f.system.restarted
		rolled, err := RunGuard(ctx, GuardOptions{DataDir: f.dataDir, Run: quietRun, Now: c.Now})
		if err != nil || !rolled {
			t.Fatalf("guard: rolled=%v err=%v", rolled, err)
		}
	}

	// First install through auto-update, rolled back by the guard.
	if err := f.updaterAt("1.1.0", c).CheckOnConnect(ctx, "1.2.0", true); err != nil {
		t.Fatal(err)
	}
	rollback()
	restored := f.updaterAt("1.1.0", c)
	if err := restored.Resume(ctx); err != nil {
		t.Fatal(err)
	}
	alerts := f.reports.nodeAlerts()
	if len(alerts) != 1 || alerts[0].GetKind() != agentv1.NodeAlertKind_NODE_ALERT_KIND_UPDATE_FAILED || alerts[0].GetResolved() ||
		!strings.Contains(alerts[0].GetMessage(), "1.2.0") || !strings.Contains(alerts[0].GetMessage(), "wait until") {
		t.Fatalf("alerts after the rollback = %v", alerts)
	}

	// The restored agent connects at once: neither path reinstalls it.
	if err := restored.CheckOnConnect(ctx, "1.2.0", true); err != nil {
		t.Fatal(err)
	}
	if err := restored.UpdateToLatest(ctx, "1.2.0"); !errors.Is(err, ErrRolledBack) {
		t.Fatalf("UpdateToLatest right after the rollback: %v", err)
	}
	if n := installs(); n != 1 {
		t.Fatalf("%d installs right after the rollback, want 1", n)
	}

	// After the hour (and another restart) it is tried once more.
	c.add(rollbackWaitFirst + time.Minute)
	if err := f.updaterAt("1.1.0", c).UpdateToLatest(ctx, "1.2.0"); err != nil {
		t.Fatal(err)
	}
	rollback()
	if err := f.updaterAt("1.1.0", c).Resume(ctx); err != nil {
		t.Fatal(err)
	}
	if a := f.reports.nodeAlerts(); len(a) != 2 || !strings.Contains(a[1].GetMessage(), "2 times") {
		t.Fatalf("alerts after the second rollback = %v", a)
	}

	// The second rollback waits a day, not an hour.
	c.add(rollbackWaitFirst + time.Minute)
	if err := f.updaterAt("1.1.0", c).CheckOnConnect(ctx, "1.2.0", true); err != nil {
		t.Fatal(err)
	}
	if n := installs(); n != 2 {
		t.Fatalf("%d installs an hour after the second rollback, want 2", n)
	}
	c.add(rollbackWaitLater)
	if err := f.updaterAt("1.1.0", c).CheckOnConnect(ctx, "1.2.0", true); err != nil {
		t.Fatal(err)
	}
	if n := installs(); n != 3 {
		t.Fatalf("%d installs a day after the second rollback, want 3", n)
	}

	// This time the new agent connects: the records go and the alert is
	// resolved.
	<-f.system.restarted
	if err := f.updaterAt("1.2.0", c).Confirm(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.dataDir, dirName, agentRollbacks)); !os.IsNotExist(err) {
		t.Fatalf("rollback records kept after a confirmed update: %v", err)
	}
	if a := f.reports.nodeAlerts(); len(a) != 3 || !a[2].GetResolved() || a[2].GetKind() != agentv1.NodeAlertKind_NODE_ALERT_KIND_UPDATE_FAILED {
		t.Fatalf("alerts after the confirmed update = %v", a)
	}
}

// An update the panel asks for (a person's choice) does not wait.
func TestRolledBackReleaseManualUpdate(t *testing.T) {
	f := newAgentFixture(t, "1.2.0")
	c := &clock{now: time.Now()}
	ctx := context.Background()
	if _, err := recordRollback(updateDir(f.dataDir), "1.2.0", c.Now()); err != nil {
		t.Fatal(err)
	}
	u := f.updaterAt("1.1.0", c)
	if _, wait := u.rolledBack("v1.2.0"); !wait {
		t.Fatal("the recorded rollback does not wait")
	}
	if err := u.Update(ctx, f.request(testManifest("1.2.0", f.binary, f.server.URL))); err != nil {
		t.Fatalf("manual update: %v", err)
	}
	<-f.system.restarted
}
