//go:build integration

package portgate

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/client"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dbtools"
	"github.com/seylo-dev/app/go/internal/proxy"
)

// TestIntegrationDatabaseTLS: exposed Redis, Mongo, Valkey, KeyDB,
// Dragonfly and ClickHouse (native port) through the gate, which
// terminates TLS. Real clients (redis-cli and valkey-cli --tls, mongosh
// tls=true, clickhouse-client --secure) in containers connect to the host
// port; plain connections are refused.
func TestIntegrationDatabaseTLS(t *testing.T) {
	if os.Getenv("SEYLO_IT") != "1" {
		t.Skip("integration test: run with scripts/dev/vm-gotest.sh")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	d, err := proxy.NewMobyDocker()
	if err != nil {
		t.Fatal(err)
	}
	var b [3]byte
	_, _ = rand.Read(b[:])
	run := "g1tls"
	if p := os.Getenv("SEYLO_IT_PREFIX"); p != "" {
		run = p
	}
	prefix := "seylo-it-" + run + "-" + hex.EncodeToString(b[:])
	labels := map[string]string{"seylo.test": prefix, "seylo.managed": "true"}
	net1 := prefix + "-p"
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), time.Minute)
		defer ccancel()
		for _, n := range []string{"redis", "mongo", "valkey", "keydb", "dragonfly", "clickhouse"} {
			_ = d.RemoveContainer(cctx, prefix+"-"+n)
		}
		_, _ = d.Client().NetworkRemove(cctx, net1, client.NetworkRemoveOptions{})
	})
	if _, err := d.EnsureNetwork(ctx, net1, labels); err != nil {
		t.Fatal(err)
	}
	engines := map[string]struct {
		image  string
		engine agentv1.DatabaseEngine
		cmd    []string
		env    []string
	}{
		"redis": {"redis:7.4-alpine", agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS, []string{"redis-server", "--requirepass", "pw"}, nil},
		"mongo": {"mongo:7.0", agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, nil, []string{"MONGO_INITDB_ROOT_USERNAME=root", "MONGO_INITDB_ROOT_PASSWORD=pw"}},
		// The engines added in 0.2, as the panel runs them.
		"valkey": {imageValkey, agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY,
			[]string{"sh", "-c", `exec docker-entrypoint.sh valkey-server --requirepass "$VALKEY_PASSWORD" --appendonly yes`}, []string{"VALKEY_PASSWORD=pw"}},
		"keydb": {imageKeyDB, agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB,
			[]string{"sh", "-c", `exec docker-entrypoint.sh keydb-server /etc/keydb/keydb.conf --requirepass "$KEYDB_PASSWORD" --appendonly yes`}, []string{"KEYDB_PASSWORD=pw"}},
		"dragonfly": {imageDragonfly, agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY,
			[]string{"dragonfly", "--logtostderr", "--dir", "/data", "--dbfilename", "dump", "--df_snapshot_format=false"}, []string{"DFLY_requirepass=pw"}},
		"clickhouse": {imageClickHouse, agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE, nil,
			[]string{"CLICKHOUSE_USER=admin", "CLICKHOUSE_PASSWORD=pw", "CLICKHOUSE_DB=app"}},
	}
	ids := map[string]string{}
	for name, e := range engines {
		if err := d.EnsureImage(ctx, e.image); err != nil {
			t.Fatal(err)
		}
		id, err := d.CreateContainer(ctx, proxy.ContainerSpec{Name: prefix + "-" + name, Image: e.image, Cmd: e.cmd, Env: e.env, Labels: labels, Network: net1})
		if err != nil {
			t.Fatal(err)
		}
		if err := d.StartContainer(ctx, id); err != nil {
			t.Fatal(err)
		}
		ids[name] = id
	}
	dir := t.TempDir()
	m := New(Config{
		Resolve: func(ctx context.Context, svc string, port uint32) (string, error) {
			info, err := d.InspectContainer(ctx, ids[svc])
			if err != nil {
				return "", err
			}
			return net.JoinHostPort(info.IPs[net1], strconv.Itoa(int(port))), nil
		},
		Certificate: func(svc, host string) ([]byte, []byte, error) { return dbtools.Certificate(nil, dir, svc, host) },
	})
	defer m.Close()
	ports := map[string]uint32{}
	for name, e := range engines {
		spec := &agentv1.ServiceSpec{Id: name, Kind: agentv1.ServiceKind_SERVICE_KIND_DATABASE,
			KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: e.engine,
				Exposure: &agentv1.DatabaseExposure{Enabled: true}}}}
		ls, _ := ListenersFor(spec)
		got, err := m.Sync(ctx, name, ls)
		if err != nil {
			t.Fatal(err)
		}
		ports[name] = got["database"]
	}
	hostIP := outboundIP(t)
	client := func(image string, args ...string) (string, error) {
		out, err := exec.CommandContext(ctx, "docker", append([]string{"run", "--rm", "--label", "seylo.test=" + prefix, image}, args...)...).CombinedOutput()
		return string(out), err
	}
	redisAddr := []string{"-h", hostIP, "-p", strconv.Itoa(int(ports["redis"])), "-a", "pw", "--no-auth-warning"}
	deadline := time.Now().Add(4 * time.Minute)
	for {
		out, err := client("redis:7.4-alpine", append(append([]string{"redis-cli", "--tls", "--insecure"}, redisAddr...), "PING")...)
		if err == nil && strings.Contains(out, "PONG") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("redis over TLS: %v %s", err, out)
		}
		time.Sleep(2 * time.Second)
	}
	if out, _ := client("redis:7.4-alpine", append(append([]string{"redis-cli"}, redisAddr...), "PING")...); strings.Contains(out, "PONG") {
		t.Fatalf("plain redis answered through the TLS port: %s", out)
	}
	mongoURL := "mongodb://root:pw@" + net.JoinHostPort(hostIP, strconv.Itoa(int(ports["mongo"]))) + "/admin?tls=true&tlsAllowInvalidCertificates=true"
	for {
		out, err := client("mongo:7.0", "mongosh", "--quiet", mongoURL, "--eval", "db.runCommand({ping: 1}).ok")
		if err == nil && strings.TrimSpace(out) == "1" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("mongo over TLS: %v %s", err, out)
		}
		time.Sleep(2 * time.Second)
	}
	plainURL := strings.Replace(mongoURL, "tls=true&tlsAllowInvalidCertificates=true", "serverSelectionTimeoutMS=3000", 1)
	if out, err := client("mongo:7.0", "mongosh", "--quiet", plainURL, "--eval", "db.runCommand({ping: 1}).ok"); err == nil && strings.TrimSpace(out) == "1" {
		t.Fatalf("plain mongo answered through the TLS port: %s", out)
	}
	// Valkey, KeyDB and Dragonfly through the gate with valkey-cli --tls
	// (one client for every Redis-like engine).
	for _, name := range []string{"valkey", "keydb", "dragonfly"} {
		addr := []string{"-h", hostIP, "-p", strconv.Itoa(int(ports[name])), "-a", "pw", "--no-auth-warning"}
		for {
			out, err := client(imageValkey, append(append([]string{"valkey-cli", "--tls", "--insecure"}, addr...), "PING")...)
			if err == nil && strings.Contains(out, "PONG") {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s over TLS: %v %s", name, err, out)
			}
			time.Sleep(2 * time.Second)
		}
		if out, _ := client(imageValkey, append(append([]string{"valkey-cli"}, addr...), "PING")...); strings.Contains(out, "PONG") {
			t.Fatalf("plain %s answered through the TLS port: %s", name, out)
		}
	}
	// ClickHouse's native port with clickhouse-client --secure.
	chArgs := []string{"clickhouse-client", "--host", hostIP, "--port", strconv.Itoa(int(ports["clickhouse"])), "--user", "admin", "--password", "pw"}
	for {
		out, err := client(imageClickHouse, append(chArgs, "--secure", "--accept-invalid-certificate", "--query", "SELECT 41 + 1")...)
		if err == nil && strings.TrimSpace(out) == "42" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("clickhouse over TLS: %v %s", err, out)
		}
		time.Sleep(2 * time.Second)
	}
	if out, err := client(imageClickHouse, append(chArgs, "--connect_timeout", "3", "--query", "SELECT 41 + 1")...); err == nil && strings.TrimSpace(out) == "42" {
		t.Fatalf("plain clickhouse answered through the TLS port: %s", out)
	}
	for name := range engines {
		if p := m.Ports(name); len(p) != 1 || !p[0].GetTls() || p[0].GetCertificateExpiresAt() == nil {
			t.Fatalf("%s ports: %v", name, p)
		}
	}
}
