package health

import (
	"encoding/binary"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// procHex prints a 32-bit word of an address the way the kernel does
// (%08X of the number held in memory).
func procHex(word uint32) string { return strings.ToUpper(hexOf(word)) }

func hexOf(n uint32) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 8)
	for i := 7; i >= 0; i-- {
		out[i] = digits[n&0xf]
		n >>= 4
	}
	return string(out)
}

// v4 is an IPv4 address column: the bytes in network order, read as a
// number in the machine's byte order ("0100007F" for 127.0.0.1 on
// little-endian machines).
func v4(a, b, c, d byte) string {
	return procHex(binary.NativeEndian.Uint32([]byte{a, b, c, d}))
}

func v6(addr [16]byte) string {
	var s strings.Builder
	for i := 0; i < 16; i += 4 {
		s.WriteString(procHex(binary.NativeEndian.Uint32(addr[i : i+4])))
	}
	return s.String()
}

const procHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

func procRow(addr string, port uint16, state string) string {
	return "   0: " + addr + ":" + strings.ToUpper(hexOf(uint32(port))[4:]) + " 00000000:0000 " + state + " 00000000:00000000 00:00000000 00000000     0        0 1 1 0 100 0 0 10 0\n"
}

func TestParseProcNetTCP(t *testing.T) {
	data := procHeader +
		procRow(v4(0, 0, 0, 0), 6000, "0A") +
		procRow(v4(127, 0, 0, 1), 9229, "0A") +
		procRow(v4(172, 23, 0, 9), 6000, "01") + // an established connection, not a listener
		procRow(v4(10, 0, 3, 4), 8080, "0A") +
		"garbage line\n"
	got := ParseProcNetTCP([]byte(data))
	var ports []uint32
	var loop []bool
	for _, s := range got {
		ports = append(ports, s.Port)
		loop = append(loop, s.Loopback)
	}
	if !reflect.DeepEqual(ports, []uint32{6000, 9229, 8080}) || !reflect.DeepEqual(loop, []bool{false, true, false}) {
		t.Fatalf("got %+v", got)
	}
	if got[1].Addr.String() != "127.0.0.1" || got[2].Addr.String() != "10.0.3.4" {
		t.Fatalf("addresses = %s, %s", got[1].Addr, got[2].Addr)
	}

	// A real line from a little-endian kernel (arm64, amd64): 127.0.0.1:6000.
	if binary.NativeEndian.Uint16([]byte{1, 0}) == 1 {
		real := procHeader + "   1: 0100007F:1770 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 39221 1 0000000000000000 100 0 0 10 0\n"
		if got := ParseProcNetTCP([]byte(real)); len(got) != 1 || got[0].Port != 6000 || got[0].Addr.String() != "127.0.0.1" || !got[0].Loopback {
			t.Fatalf("real line = %+v", got)
		}
	}

	loopback6 := [16]byte{15: 1}
	mapped := [16]byte{10: 0xff, 11: 0xff, 12: 127, 15: 1}
	any6 := [16]byte{}
	data6 := procHeader + procRow(v6(loopback6), 5432, "0A") + procRow(v6(mapped), 3000, "0A") + procRow(v6(any6), 80, "0A")
	got = ParseProcNetTCP([]byte(data6))
	if len(got) != 3 || !got[0].Loopback || got[0].Addr.String() != "::1" || !got[1].Loopback || got[2].Loopback || got[2].Port != 80 {
		t.Fatalf("tcp6 = %+v", got)
	}
}

// ReadListening merges tcp and tcp6 per port: a port is loopback only when
// every socket on it is. A missing tcp6 (IPv6 off) is fine; no files at all
// is an error.
func TestReadListening(t *testing.T) {
	dir := t.TempDir()
	net := filepath.Join(dir, "42", "net")
	if err := os.MkdirAll(net, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(net, name), []byte(procHeader+body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Docker's embedded DNS server (127.0.0.11 on a random port) is not the app's.
	write("tcp", procRow(v4(127, 0, 0, 1), 6000, "0A")+procRow(v4(127, 0, 0, 11), 40121, "0A")+procRow(v4(127, 0, 0, 1), 3000, "0A"))
	lo := netip.MustParseAddr("127.0.0.1")
	got, err := ReadListening(dir, 42)
	if err != nil || !reflect.DeepEqual(got, []ListenPort{{Port: 3000, LoopbackOnly: true, Loopback: lo}, {Port: 6000, LoopbackOnly: true, Loopback: lo}}) {
		t.Fatalf("tcp only: %+v, %v", got, err)
	}
	write("tcp6", procRow(v6([16]byte{}), 6000, "0A"))
	got, err = ReadListening(dir, 42)
	if err != nil || !reflect.DeepEqual(got, []ListenPort{{Port: 3000, LoopbackOnly: true, Loopback: lo}, {Port: 6000}}) {
		t.Fatalf("tcp and tcp6: %+v, %v", got, err)
	}
	if _, err := ReadListening(dir, 43); err == nil {
		t.Fatal("no process: want an error")
	}
	if _, err := ReadListening(dir, 0); err == nil {
		t.Fatal("pid 0: want an error")
	}
	// Nothing listens: an empty list, no error.
	write("tcp", "")
	write("tcp6", "")
	if got, err := ReadListening(dir, 42); err != nil || len(got) != 0 {
		t.Fatalf("empty: %+v, %v", got, err)
	}
}
