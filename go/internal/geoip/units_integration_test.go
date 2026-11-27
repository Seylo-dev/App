//go:build integration

package geoip

// The lookup server under real systemd in the test VM: socket activation
// with FreeBind (the socket comes up before its address exists, as at boot
// before Docker made the edge bridge), the sandboxed service (no network
// of its own, read-only system) answering on the socket it is handed, and
// restarts and crashes that delay requests instead of failing them.
//
//	cd go && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o ../.vmbin/seylo ./cmd/seylo
//	SEYLO_IT_GEOIP_BIN=$PWD/.vmbin/seylo scripts/dev/vm-gotest.sh ./internal/geoip -run IntegrationSystemd -v
//
// It installs seylo-geoip.socket and .service in /etc/systemd/system and
// removes them afterwards: use the test VM only.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/geoip/geoiptest"
	"github.com/seylo-dev/app/go/internal/systemd"
)

func TestIntegrationSystemdUnits(t *testing.T) {
	src := os.Getenv("SEYLO_IT_GEOIP_BIN")
	if os.Getenv("SEYLO_IT") != "1" || src == "" {
		t.Skip("integration test: SEYLO_IT_GEOIP_BIN=<linux seylo binary> scripts/dev/vm-gotest.sh")
	}
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		t.Skip("no systemd")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	run := func(name string, args ...string) {
		t.Helper()
		if out, err := exec.Command(name, args...).CombinedOutput(); err != nil {
			t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, out)
		}
	}

	bin := "/usr/local/bin/seylo-it-geoip"
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, data, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(bin) })
	dir := "/var/lib/seylo-it-geoip"
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	dbPath := filepath.Join(dir, "country.mmdb")
	if err := writeAtomic(dbPath, geoiptest.Write("DBIP-Country-Lite", time.Now(), geoiptest.N("88.214.55.0/24", "IL")), 0o644); err != nil {
		t.Fatal(err)
	}

	// An address no interface has yet, like the edge gateway at boot.
	const addr = "10.250.77.1"
	listen := addr + ":5758"
	u := Units{Dir: systemd.UnitDir, Run: systemd.ExecRunner}
	t.Cleanup(func() {
		_ = u.Remove(context.Background())
		_ = exec.Command("ip", "link", "del", "sgeo0").Run()
	})
	if _, err := u.Ensure(ctx, listen, bin, dbPath); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if out, err := exec.Command("systemctl", "is-active", SocketUnit).CombinedOutput(); err != nil {
		t.Fatalf("the socket is not active before its address exists: %s", out)
	}
	run("ip", "link", "add", "sgeo0", "type", "dummy")
	run("ip", "addr", "add", addr+"/32", "dev", "sgeo0")
	run("ip", "link", "set", "sgeo0", "up")

	client := &http.Client{Timeout: 10 * time.Second}
	country := func(ip string) (string, error) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+listen+"/", nil)
		req.Header.Set("X-Real-Ip", ip)
		resp, err := client.Do(req)
		if err != nil {
			return "", err
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		if resp.StatusCode != http.StatusOK {
			return "", &statusError{resp.StatusCode}
		}
		return resp.Header.Get(Header), nil
	}
	if got, err := country("88.214.55.20"); err != nil || got != "IL" {
		t.Fatalf("first lookup = %q, %v", got, err)
	}
	resp, err := client.Get("http://" + listen + HealthPath)
	if err != nil {
		t.Fatal(err)
	}
	var h Health
	_ = json.NewDecoder(resp.Body).Decode(&h)
	resp.Body.Close()
	if h.Protocol != ServerProtocol || h.Database == nil {
		t.Fatalf("health = %+v (the sandboxed service did not read %s?)", h, dbPath)
	}

	// Lookups while the service restarts and crashes: none fails.
	var failed, done atomic.Int64
	var mu sync.Mutex
	var firstErr error
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				if got, err := country("88.214.55.20"); err != nil || got != "IL" {
					failed.Add(1)
					mu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					mu.Unlock()
				}
				done.Add(1)
			}
		}()
	}
	time.Sleep(300 * time.Millisecond)
	if err := u.RestartService(ctx); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	run("systemctl", "kill", "--kill-whom=main", "--signal=SIGKILL", ServiceUnit)
	time.Sleep(2500 * time.Millisecond) // RestartSec=1, then the next start
	close(stop)
	wg.Wait()
	if failed.Load() > 0 {
		t.Errorf("%d of %d lookups failed across a restart and a crash; first: %v", failed.Load(), done.Load(), firstErr)
	}
	t.Logf("%d lookups across a restart and a crash, %d failed", done.Load(), failed.Load())

	if err := u.Remove(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := country("88.214.55.20"); err == nil {
		t.Error("the lookup still answers after Remove")
	}
}

type statusError struct{ code int }

func (e *statusError) Error() string { return http.StatusText(e.code) }
