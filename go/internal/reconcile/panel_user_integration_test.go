//go:build integration

package reconcile

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/update"
)

// TestITLegacyPanelMovesToThePanelUser: real Docker, real ownership. A
// panel left by an agent from before the panel user (running as uid 1000,
// its folder and master.key owned by uid 1000, master.key 0644) is replaced
// at the same generation by one running as docker.PanelUser, after the
// folder went to that user (0700, master.key 0600): the new container
// reads master.key, uid 1000 on the host cannot, and a link in the folder
// pointing outside it changes nothing outside. A panel update afterwards
// (a broken image that rolls back) keeps the panel user and the restored
// database readable. Needs the reserved panel id (the user applies to the
// panel only), so it skips when a panel container already runs here.
func TestITLegacyPanelMovesToThePanelUser(t *testing.T) {
	e := newIT(t)
	if os.Geteuid() != 0 {
		t.Skip("needs root (scripts/dev/vm-gotest.sh runs as root)")
	}
	ctx := context.Background()
	id := docker.PanelServiceID
	name := docker.ContainerName(id, 1, 0)
	for _, n := range []string{name, name + prevSuffix, docker.ContainerName(id, 2, 0), docker.ContainerName(id, 3, 0)} {
		if _, err := e.eng.InspectContainer(ctx, n); err == nil {
			t.Skipf("a panel container %s already exists on this Docker", n)
		}
	}
	project := e.prefix + "pp"
	network := docker.ProjectNetwork(project)
	if out, err := exec.Command("docker", "network", "create", "--label", docker.LabelManaged+"=true",
		"--label", docker.LabelProject+"="+project, "--label", "seylo.it="+e.prefix, network).CombinedOutput(); err != nil {
		t.Fatalf("network: %v %s", err, out)
	}
	// Let any user reach the data dir, so only the panel folder's own
	// owner and mode decide who reads master.key.
	for p := e.layout.Root(); p != "/" && p != os.TempDir(); p = filepath.Dir(p) {
		_ = os.Chmod(p, 0o755)
	}

	dir := filepath.Join(e.layout.Root(), "panel")
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(dir, "uploads"), 0o755))
	must(os.Chmod(dir, 0o750))
	must(os.WriteFile(filepath.Join(dir, "master.key"), []byte("the-master-key\n"), 0o644))
	must(os.WriteFile(filepath.Join(dir, "panel.db"), []byte("v1 rows"), 0o644))
	must(os.WriteFile(filepath.Join(dir, "uploads", "u1.tar.gz"), []byte("upload"), 0o644))
	outside := filepath.Join(t.TempDir(), "outside")
	must(os.WriteFile(outside, []byte("not the panel's"), 0o644))
	must(os.Symlink(outside, filepath.Join(dir, "escape")))
	must(filepath.Walk(dir, func(p string, _ os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(p, 1000, 1000)
	}))

	// What an agent from before the panel user ran: the image's uid 1000, no seylo.user label.
	labels := docker.InstanceLabels{ServiceID: id, ProjectID: project, Kind: "app", Generation: 1, Protected: true}
	spec := &agentv1.ServiceSpec{
		Id: id, ProjectId: project, Name: "panel", Kind: agentv1.ServiceKind_SERVICE_KIND_APP,
		Generation: 1, Protected: true,
		Image:          &agentv1.ImageRef{Reference: itImage},
		Container:      &agentv1.ContainerConfig{Command: []string{"httpd", "-f", "-p", "3000", "-h", "/"}, StopGracePeriod: durationpb.New(time.Second)},
		Ports:          []*agentv1.PortSpec{{ContainerPort: 3000, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_TCP}},
		NetworkAliases: []string{"panel"},
		CrashPolicy:    &agentv1.CrashPolicy{Restart: true},
		Deploy:         &agentv1.DeployStrategy{Mode: agentv1.DeployMode_DEPLOY_MODE_RECREATE, HealthTimeout: durationpb.New(30 * time.Second)},
	}
	labels.SpecHash = SpecHash(spec)
	args := []string{"run", "-d", "--name", name, "--user", "1000:1000", "--network", network, "--network-alias", "panel",
		"--label", "seylo.it=" + e.prefix, "-v", dir + ":" + brand.DataDir + "/panel"}
	for k, v := range labels.Map() {
		args = append(args, "--label", k+"="+v)
	}
	args = append(args, itImage, "httpd", "-f", "-p", "3000", "-h", "/")
	out, err := exec.Command("docker", args...).Output()
	if err != nil {
		t.Fatalf("legacy panel container: %v", err)
	}
	legacyID := strings.TrimSpace(string(out))
	if got := dockerOut(t, "exec", name, "cat", brand.DataDir+"/panel/master.key"); got != "the-master-key" {
		t.Fatalf("the legacy panel reads %q", got)
	}

	e.apply(1, spec)
	deadline := time.Now().Add(time.Minute)
	for {
		list := e.containers(id)
		if len(list) == 1 && list[0].ID != legacyID && list[0].State == agentv1.InstanceState_INSTANCE_STATE_RUNNING {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the panel was not moved to the panel user: %+v", list)
		}
		time.Sleep(200 * time.Millisecond)
	}
	e.settle()
	if got := dockerOut(t, "inspect", "--format", "{{.Config.User}} {{index .Config.Labels \""+docker.LabelUser+"\"}}", name); got != docker.PanelUser+" "+docker.PanelUser {
		t.Fatalf("the new panel container runs as %q", got)
	}
	if got := dockerOut(t, "exec", name, "id", "-u"); got != "61000" {
		t.Fatalf("id -u in the panel = %q", got)
	}
	if got := dockerOut(t, "exec", name, "cat", brand.DataDir+"/panel/master.key"); got != "the-master-key" {
		t.Fatalf("the panel user reads %q", got)
	}
	for _, p := range []string{"", "master.key", "panel.db", "uploads", "uploads/u1.tar.gz", "escape"} {
		var st syscall.Stat_t
		must(syscall.Lstat(filepath.Join(dir, p), &st))
		if st.Uid != docker.PanelUID || st.Gid != docker.PanelGID {
			t.Errorf("%s is owned by %d:%d, want the panel user", p, st.Uid, st.Gid)
		}
	}
	if info, _ := os.Stat(dir); info.Mode().Perm() != 0o700 {
		t.Errorf("the panel folder is %v", info.Mode().Perm())
	}
	if info, _ := os.Stat(filepath.Join(dir, "master.key")); info.Mode().Perm() != 0o600 {
		t.Errorf("master.key is %v", info.Mode().Perm())
	}
	var st syscall.Stat_t
	must(syscall.Stat(outside, &st))
	if st.Uid != 0 {
		t.Errorf("the file the link points at went to uid %d", st.Uid)
	}
	// uid 1000 (the default login user of most cloud images) cannot read it now.
	if setpriv, err := exec.LookPath("setpriv"); err == nil {
		out, err := exec.Command(setpriv, "--reuid=1000", "--regid=1000", "--clear-groups", "cat", filepath.Join(dir, "master.key")).CombinedOutput()
		if err == nil || !strings.Contains(string(out), "Permission denied") {
			t.Errorf("uid 1000 read master.key: %v %s", err, out)
		}
	}

	// A panel update under this agent: the broken image fails, the old one
	// comes back as the panel user and reads the restored database.
	results := make(chan *agentv1.UpdateResult, 4)
	sw := update.NewPanelSwapper(update.PanelOptions{
		DataDir: e.layout.Root(),
		Runtime: &update.ReconcileRuntime{Load: e.desired.Load, Apply: e.rt.Apply, Status: e.state.get, PullImage: e.eng.PullImage},
		Report: func(_ context.Context, ev *agentv1.Event) error {
			results <- ev.GetUpdateResult()
			return nil
		},
	}, nil)
	sw.SetBackground(ctx)
	const broken = "alpine:3.20"
	badDigest, err := e.eng.PullImage(ctx, broken, nil)
	must(err)
	must(sw.Swap(ctx, &agentv1.UpdatePanelRequest{
		UpdateId: "u1", ServiceId: id,
		Image:         &agentv1.ImageRef{Reference: broken, Digest: badDigest},
		HealthTimeout: durationpb.New(20 * time.Second),
	}))
	if r := waitResult(t, results); r.GetSuccess() || !r.GetRolledBack() {
		t.Fatalf("broken swap: %v", r)
	}
	e.settle()
	waitPhase(t, e, id, 3, agentv1.ServicePhase_SERVICE_PHASE_RUNNING)
	restored := docker.ContainerName(id, 3, 0)
	if got := dockerOut(t, "exec", restored, "sh", "-c", "id -u; cat "+brand.DataDir+"/panel/panel.db"); got != "61000\nv1 rows" {
		t.Fatalf("the restored panel: %q", got)
	}
	must(syscall.Stat(filepath.Join(dir, "panel.db"), &st))
	if st.Uid != docker.PanelUID {
		t.Fatalf("the restored panel.db is owned by %d", st.Uid)
	}
}

func dockerOut(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v %s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}
