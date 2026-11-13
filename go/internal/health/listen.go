package health

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// ListenPort is a TCP port something in a container listens on.
type ListenPort struct {
	Port uint32
	// LoopbackOnly: every listening socket on the port is bound to a
	// loopback address (127.0.0.0/8, ::1), so nothing outside the
	// container reaches it.
	LoopbackOnly bool
	// Loopback is the loopback address a LoopbackOnly port is bound to
	// (127.0.0.1, ::1), for the hint.
	Loopback netip.Addr
}

// tcpListen is the "st" column of a socket in LISTEN state
// (include/net/tcp_states.h TCP_LISTEN = 10).
const tcpListen = "0A"

// maxProcNet bounds how much of one /proc/<pid>/net/tcp file is read.
const maxProcNet = 4 << 20

// dockerDNS is the address of Docker's embedded DNS server, which listens
// on a random TCP port inside every container on a user-defined network
// (port 53 is redirected to it).
var dockerDNS = netip.AddrFrom4([4]byte{127, 0, 0, 11})

// ReadListening returns the TCP ports in LISTEN state in the network
// namespace of process pid, read from <procDir>/<pid>/net/tcp and tcp6
// (procDir is /proc outside tests): what the container whose process that
// is listens on, without running anything inside it. The result is
// ascending, one entry per port. An error means neither file could be read
// (no such process, no /proc, not allowed); a missing tcp6 (IPv6 off) is
// not one.
func ReadListening(procDir string, pid int) ([]ListenPort, error) {
	if pid <= 0 {
		return nil, fmt.Errorf("no process")
	}
	dir := filepath.Join(procDir, strconv.Itoa(pid), "net")
	type acc struct {
		public   bool
		loopback netip.Addr
	}
	seen := map[uint32]*acc{}
	read := 0
	var firstErr error
	for _, name := range []string{"tcp", "tcp6"} {
		data, err := readCapped(filepath.Join(dir, name))
		if err != nil {
			if firstErr == nil && (name == "tcp" || !errors.Is(err, os.ErrNotExist)) {
				firstErr = err
			}
			continue
		}
		read++
		for _, s := range ParseProcNetTCP(data) {
			if s.Addr.Unmap() == dockerDNS {
				// Docker's embedded DNS server, in every container on a
				// user-defined network, not the app's.
				continue
			}
			a := seen[s.Port]
			if a == nil {
				a = &acc{}
				seen[s.Port] = a
			}
			if !s.Loopback {
				a.public = true
			} else if !a.loopback.IsValid() {
				a.loopback = s.Addr.Unmap()
			}
		}
	}
	if read == 0 {
		return nil, firstErr
	}
	out := make([]ListenPort, 0, len(seen))
	for port, a := range seen {
		p := ListenPort{Port: port, LoopbackOnly: !a.public}
		if p.LoopbackOnly {
			p.Loopback = a.loopback
		}
		out = append(out, p)
	}
	slices.SortFunc(out, func(a, b ListenPort) int { return int(a.Port) - int(b.Port) })
	return out, nil
}

func readCapped(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(io.LimitReader(f, maxProcNet)); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ListenSocket is one LISTEN line of /proc/<pid>/net/tcp or tcp6.
type ListenSocket struct {
	Port     uint32
	Addr     netip.Addr
	Loopback bool
}

// ParseProcNetTCP returns the sockets in LISTEN state of a
// /proc/<pid>/net/tcp or tcp6 file. Lines it cannot read are skipped. The
// kernel prints each 32-bit word of an address as the number it holds in
// memory, so on the little-endian machines agents run on 127.0.0.1 reads
// "0100007F"; the port is printed big-endian.
func ParseProcNetTCP(data []byte) []ListenSocket {
	var out []ListenSocket
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 4096), 64<<10)
	first := true
	for sc.Scan() {
		if first {
			// The header: "  sl  local_address rem_address   st ..."
			first = false
			continue
		}
		f := strings.Fields(sc.Text())
		if len(f) < 4 || f[3] != tcpListen {
			continue
		}
		host, portHex, ok := strings.Cut(f[1], ":")
		if !ok {
			continue
		}
		port, err := strconv.ParseUint(portHex, 16, 16)
		if err != nil || port == 0 {
			continue
		}
		addr, ok := procAddr(host)
		if !ok {
			continue
		}
		out = append(out, ListenSocket{Port: uint32(port), Addr: addr, Loopback: addr.Unmap().IsLoopback()})
	}
	return out
}

// procAddr decodes the address column: 8 hex digits for IPv4, 32 for IPv6,
// each 32-bit word in the machine's byte order.
func procAddr(s string) (netip.Addr, bool) {
	raw, err := hex.DecodeString(s)
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return netip.Addr{}, false
	}
	b := make([]byte, len(raw))
	for i := 0; i < len(raw); i += 4 {
		binary.NativeEndian.PutUint32(b[i:], binary.BigEndian.Uint32(raw[i:]))
	}
	addr, ok := netip.AddrFromSlice(b)
	return addr, ok
}
