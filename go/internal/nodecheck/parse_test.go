package nodecheck

import (
	"os"
	"path/filepath"
	"testing"
)

const procNetTCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 23456 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 777 1 0000000000000000 100 0 0 10 0
   2: 0F02000A:01BB 0A00000A:D2C4 01 00000000:00000000 00:00000000 00000000     0        0 0 1 0000000000000000 100 0 0 10 0
`

func TestParseProcNetTCP(t *testing.T) {
	got := parseProcNetTCP(procNetTCP)
	if len(got) != 2 || got[0] != (Listener{80, "23456"}) || got[1] != (Listener{8080, "777"}) {
		t.Fatalf("listeners = %+v (established sockets must be skipped)", got)
	}
}

func TestSocketOwners(t *testing.T) {
	proc := t.TempDir()
	fd := filepath.Join(proc, "4242", "fd")
	if err := os.MkdirAll(fd, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(proc, "4242", "comm"), []byte("nginx\n"), 0o644)
	_ = os.Symlink("socket:[23456]", filepath.Join(fd, "6"))
	_ = os.Symlink("/dev/null", filepath.Join(fd, "0"))
	got := socketOwners(proc, map[string]bool{"23456": true})
	if got["23456"] != "nginx (pid 4242)" {
		t.Fatalf("owners = %v", got)
	}
}

func TestParseOSRelease(t *testing.T) {
	rel := parseOSRelease("NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nID=ubuntu\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n# comment\n")
	if rel["ID"] != "ubuntu" || rel["VERSION_ID"] != "24.04" || rel["PRETTY_NAME"] != "Ubuntu 24.04.1 LTS" {
		t.Fatalf("os-release = %v", rel)
	}
}

func TestParseMeminfo(t *testing.T) {
	m := parseMeminfo("MemTotal:        2014464 kB\nMemAvailable:     512000 kB\nHugePages_Total:       0\n")
	if m["MemTotal"] != 2014464*1024 || m["MemAvailable"] != 512000*1024 || m["HugePages_Total"] != 0 {
		t.Fatalf("meminfo = %v", m)
	}
}

func TestParseKernel(t *testing.T) {
	for in, want := range map[string][2]int{"6.8.0-45-generic": {6, 8}, "5.15.167.4-microsoft-standard-WSL2": {5, 15}, "5.4rc1": {5, 4}} {
		major, minor, ok := parseKernel(in)
		if !ok || major != want[0] || minor != want[1] {
			t.Errorf("parseKernel(%q) = %d.%d %v", in, major, minor, ok)
		}
	}
	if _, _, ok := parseKernel("weird"); ok {
		t.Fatal("parsed garbage")
	}
}

func TestUFWAllows(t *testing.T) {
	status := `Status: active

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere
80,443/tcp                 ALLOW       Anywhere
8000:9000/tcp              ALLOW       Anywhere
22/tcp (v6)                ALLOW       Anywhere (v6)
`
	if !ufwAllows(status, 80) || !ufwAllows(status, 443) || ufwAllows(status, 25) || !ufwAllows(status, 8500) {
		t.Fatal("ufw rules misread")
	}
	if !ufwAllows("Nginx Full                 ALLOW       Anywhere\n", 443) {
		t.Fatal("ufw app profile misread")
	}
	if ufwAllows("80/tcp                     DENY        Anywhere\n", 80) {
		t.Fatal("deny read as allow")
	}
}

func TestFirewalldAllows(t *testing.T) {
	all := "public (active)\n  services: dhcpv6-client ssh http\n  ports: 443/tcp 8080/tcp\n"
	if !firewalldAllows(all, 80) || !firewalldAllows(all, 443) || firewalldAllows("  services: ssh\n", 80) {
		t.Fatal("firewalld rules misread")
	}
}
