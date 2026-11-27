package geoip

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

type recorder struct{ calls []string }

func (r *recorder) run(_ context.Context, _ io.Writer, name string, args ...string) error {
	r.calls = append(r.calls, name+" "+strings.Join(args, " "))
	return nil
}

func TestUnitFiles(t *testing.T) {
	socket := SocketUnitFile("172.30.0.1:5758")
	for _, want := range []string{"ListenStream=172.30.0.1:5758", "FreeBind=yes", "WantedBy=sockets.target"} {
		if !strings.Contains(socket, want) {
			t.Errorf("socket unit lacks %q:\n%s", want, socket)
		}
	}
	service := ServiceUnitFile("/usr/local/bin/seylo", "/var/lib/seylo/geoip/country.mmdb")
	for _, want := range []string{
		"ExecStart=/usr/local/bin/seylo geoip serve --db /var/lib/seylo/geoip/country.mmdb",
		"Requires=" + SocketUnit,
		"Restart=always",
		// The socket comes from systemd, so the server needs no network.
		"PrivateNetwork=yes",
		"ProtectSystem=strict",
		"CapabilityBoundingSet=\n",
	} {
		if !strings.Contains(service, want) {
			t.Errorf("service unit lacks %q:\n%s", want, service)
		}
	}
	if strings.Contains(service, "[Install]") {
		t.Error("the service is started by its socket, it needs no [Install]")
	}
}

func TestUnitsEnsure(t *testing.T) {
	dir := t.TempDir()
	rec := &recorder{}
	u := Units{Dir: dir, Run: rec.run}
	ctx := context.Background()

	changed, err := u.Ensure(ctx, "172.30.0.1:5758", "/usr/local/bin/seylo", "/var/lib/seylo/geoip/country.mmdb")
	if err != nil || !changed {
		t.Fatalf("first Ensure = %v, %v", changed, err)
	}
	want := []string{
		"systemctl daemon-reload",
		"systemctl stop " + ServiceUnit,
		"systemctl enable " + SocketUnit,
		"systemctl restart " + SocketUnit,
		"systemctl enable --now " + SocketUnit,
	}
	if !slices.Equal(rec.calls, want) {
		t.Errorf("first Ensure ran %q, want %q", rec.calls, want)
	}
	if !u.Installed() {
		t.Error("not installed")
	}

	rec.calls = nil
	if changed, err := u.Ensure(ctx, "172.30.0.1:5758", "/usr/local/bin/seylo", "/var/lib/seylo/geoip/country.mmdb"); err != nil || changed {
		t.Fatalf("same Ensure = %v, %v", changed, err)
	}
	if !slices.Equal(rec.calls, []string{"systemctl enable --now " + SocketUnit}) {
		t.Errorf("same Ensure ran %q", rec.calls)
	}

	// Only the service changed: restart it, the socket keeps listening.
	rec.calls = nil
	if changed, err := u.Ensure(ctx, "172.30.0.1:5758", "/opt/seylo", "/var/lib/seylo/geoip/country.mmdb"); err != nil || !changed {
		t.Fatalf("new binary Ensure = %v, %v", changed, err)
	}
	want = []string{"systemctl daemon-reload", "systemctl try-restart " + ServiceUnit, "systemctl enable --now " + SocketUnit}
	if !slices.Equal(rec.calls, want) {
		t.Errorf("new binary Ensure ran %q, want %q", rec.calls, want)
	}

	// The edge network got another gateway: a new socket.
	rec.calls = nil
	if _, err := u.Ensure(ctx, "172.31.0.1:5758", "/opt/seylo", "/var/lib/seylo/geoip/country.mmdb"); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(rec.calls, "systemctl restart "+SocketUnit) {
		t.Errorf("new address Ensure ran %q", rec.calls)
	}
	data, _ := os.ReadFile(filepath.Join(dir, SocketUnit))
	if !strings.Contains(string(data), "ListenStream=172.31.0.1:5758") {
		t.Errorf("socket unit:\n%s", data)
	}

	rec.calls = nil
	if err := u.Remove(ctx); err != nil {
		t.Fatal(err)
	}
	want = []string{"systemctl disable --now " + SocketUnit + " " + ServiceUnit, "systemctl daemon-reload"}
	if !slices.Equal(rec.calls, want) {
		t.Errorf("Remove ran %q, want %q", rec.calls, want)
	}
	if u.Installed() {
		t.Error("still installed")
	}
	for _, name := range []string{SocketUnit, ServiceUnit} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Errorf("%s still there: %v", name, err)
		}
	}
	rec.calls = nil
	if err := u.Remove(ctx); err != nil || len(rec.calls) != 0 {
		t.Errorf("Remove when nothing is installed: %v, ran %q", err, rec.calls)
	}
}
