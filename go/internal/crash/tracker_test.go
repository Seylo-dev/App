package crash

import (
	"slices"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func TestStreaks(t *testing.T) {
	now := time.Unix(10_000, 0)
	tr := NewTracker(func() time.Time { return now })
	policy := &agentv1.CrashPolicy{Restart: true, StopAfterCrashes: 3}
	exit := func(ranFor time.Duration) Exit {
		return Exit{ServiceID: "web", Generation: 4, ExitCode: 1, StartedAt: now.Add(-ranFor), ExitedAt: now, LastLines: []string{"boom"}}
	}

	d := tr.Exited(policy, exit(time.Second))
	if !d.Restart || d.Delay != DefaultDelay || d.Report.GetStreak() != 1 || d.Report.GetAction() != agentv1.CrashAction_CRASH_ACTION_RESTARTING {
		t.Fatalf("first crash: %+v", d)
	}
	d = tr.Exited(policy, exit(time.Second))
	if d.Report.GetStreak() != 2 || !d.Restart {
		t.Fatalf("second crash: %+v", d)
	}
	d = tr.Exited(policy, exit(time.Second))
	if d.Restart || d.Report.GetAction() != agentv1.CrashAction_CRASH_ACTION_GAVE_UP || d.Report.GetStreak() != 3 {
		t.Fatalf("third crash should give up: %+v", d)
	}

	// Running long enough ends the streak.
	tr.Reset("web")
	tr.Exited(policy, exit(time.Second))
	tr.Running("web", now)
	now = now.Add(StableAfter)
	if got := tr.Streak("web"); got != 0 {
		t.Fatalf("streak after a stable run = %d", got)
	}
	// A crash after a long run starts a new streak at 1.
	d = tr.Exited(policy, exit(StableAfter+time.Minute))
	if d.Report.GetStreak() != 1 {
		t.Fatalf("streak after long run = %d", d.Report.GetStreak())
	}
}

func TestPolicies(t *testing.T) {
	tr := NewTracker(nil)
	off := &agentv1.CrashPolicy{Restart: false}
	d := tr.Exited(off, Exit{ServiceID: "a", OOMKilled: true})
	if d.Restart || d.Report.GetAction() != agentv1.CrashAction_CRASH_ACTION_LEFT_STOPPED || !d.Report.GetOomKilled() {
		t.Fatalf("restart off: %+v", d)
	}
	forever := &agentv1.CrashPolicy{Restart: true, RestartDelay: durationpb.New(2 * time.Second)}
	for i := range 50 {
		d = tr.Exited(forever, Exit{ServiceID: "b"})
		if !d.Restart || d.Delay != 2*time.Second || d.Report.GetStreak() != uint32(i+1) {
			t.Fatalf("crash %d: %+v", i, d)
		}
	}
	if d := tr.Exited(nil, Exit{ServiceID: "c"}); !d.Restart {
		t.Fatal("no policy restarts")
	}
	tr.Forget("b")
	if tr.Streak("b") != 0 {
		t.Fatal("forget keeps the streak")
	}
}

func TestReportKeepsLast100Lines(t *testing.T) {
	var lines []string
	for i := range 250 {
		lines = append(lines, string(rune('a'+i%26)))
	}
	d := NewTracker(nil).Exited(nil, Exit{ServiceID: "a", LastLines: lines})
	if got := d.Report.GetLastLines(); len(got) != MaxLines || got[len(got)-1] != lines[len(lines)-1] {
		t.Fatalf("lines = %d", len(got))
	}
}

func TestRedact(t *testing.T) {
	got := Redact([]string{"connecting with hunter22 to db", "x=ab"}, []string{"hunter22", "ab"})
	want := []string{"connecting with [redacted] to db", "x=ab"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q", got)
	}
}

// A long-running sibling replica must not end the streak of the replica
// that keeps crashing: stop_after_crashes has to fire and the panel must
// see one streak, not a new one per crash.
func TestStreakIgnoresStableSibling(t *testing.T) {
	now := time.Unix(100_000, 0)
	tr := NewTracker(func() time.Time { return now })
	policy := &agentv1.CrashPolicy{Restart: true, StopAfterCrashes: 3}
	siblingUp := now.Add(-24 * time.Hour)
	var last Decision
	for i := range 3 {
		// Every reconcile pass reports both replicas: the stable one (up
		// for a day) and the crashing one right after its restart.
		tr.Running("web", siblingUp)
		started := now
		now = now.Add(10 * time.Second)
		last = tr.Exited(policy, Exit{ServiceID: "web", ExitCode: 1, StartedAt: started, ExitedAt: now})
		if got := last.Report.GetStreak(); got != uint32(i+1) {
			t.Fatalf("crash %d: streak %d", i+1, got)
		}
		now = now.Add(DefaultDelay)
		tr.Running("web", siblingUp)
		tr.Running("web", now) // the restarted replica
	}
	if last.Restart || last.Report.GetAction() != agentv1.CrashAction_CRASH_ACTION_GAVE_UP {
		t.Fatalf("third crash with a stable sibling must give up: %+v", last.Report)
	}
}

func TestStreakEndsWhenTheRestartedReplicaStaysUp(t *testing.T) {
	now := time.Unix(100_000, 0)
	tr := NewTracker(func() time.Time { return now })
	policy := &agentv1.CrashPolicy{Restart: true, StopAfterCrashes: 3}
	tr.Exited(policy, Exit{ServiceID: "web", ExitCode: 1, StartedAt: now.Add(-time.Second), ExitedAt: now})
	restarted := now.Add(DefaultDelay)
	now = restarted
	tr.Running("web", restarted)
	now = now.Add(StableAfter)
	tr.Running("web", restarted)
	if got := tr.Streak("web"); got != 0 {
		t.Fatalf("streak after the restarted replica stayed up: %d", got)
	}
	// Its own long run ending in a crash also starts a new streak.
	d := tr.Exited(policy, Exit{ServiceID: "web", ExitCode: 1, StartedAt: restarted, ExitedAt: now})
	if d.Report.GetStreak() != 1 {
		t.Fatalf("crash after a stable run: streak %d", d.Report.GetStreak())
	}
}

func TestSeedRestoresAStreak(t *testing.T) {
	now := time.Unix(100_000, 0)
	tr := NewTracker(func() time.Time { return now })
	policy := &agentv1.CrashPolicy{Restart: true, StopAfterCrashes: 3}
	tr.Seed("web", 2, now.Add(-time.Minute))
	tr.Seed("web", 9, now) // an existing streak wins
	d := tr.Exited(policy, Exit{ServiceID: "web", ExitCode: 1, StartedAt: now.Add(-30 * time.Second), ExitedAt: now})
	if d.Report.GetStreak() != 3 || d.Restart {
		t.Fatalf("seeded streak: %+v", d.Report)
	}
}

func TestSecretValues(t *testing.T) {
	spec := &agentv1.ServiceSpec{
		Env:   []*agentv1.EnvVar{{Name: "A", Value: "plain"}, {Name: "KEY", Value: "env-secret", Secret: true}},
		Image: &agentv1.ImageRef{Auth: &agentv1.RegistryAuth{Username: "u", Password: "registry-pass"}},
		KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{
			Credentials: &agentv1.DatabaseCredentials{AdminPassword: "admin-pass"},
			Exposure:    &agentv1.DatabaseExposure{Enabled: true, User: "ext", Password: "exposed-pass"},
		}},
		DevAccess: &agentv1.DevAccess{CloudflareTunnel: &agentv1.CloudflareTunnel{Enabled: true, Token: "tunnel-token"}},
	}
	got := SecretValues(spec)
	slices.Sort(got)
	want := []string{"admin-pass", "env-secret", "exposed-pass", "registry-pass", "tunnel-token"}
	if !slices.Equal(got, want) {
		t.Fatalf("SecretValues = %q, want %q", got, want)
	}
	if got := SecretValues(&agentv1.ServiceSpec{}); len(got) != 0 {
		t.Fatalf("empty spec: %q", got)
	}
}
