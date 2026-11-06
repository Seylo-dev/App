package nodecheck

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Listener is a listening TCP socket from /proc/net/tcp{,6}.
type Listener struct {
	Port  uint16
	Inode string
}

// parseProcNetTCP returns the LISTEN sockets of a /proc/net/tcp file.
// Lines look like:
//
//	sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
//	 0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 23456 1 ...
func parseProcNetTCP(data string) []Listener {
	var out []Listener
	for line := range strings.SplitSeq(data, "\n") {
		f := strings.Fields(line)
		if len(f) < 10 || f[3] != "0A" {
			continue
		}
		_, portHex, ok := strings.Cut(f[1], ":")
		if !ok {
			continue
		}
		port, err := strconv.ParseUint(portHex, 16, 16)
		if err != nil {
			continue
		}
		out = append(out, Listener{Port: uint16(port), Inode: f[9]})
	}
	return out
}

// socketOwners maps socket inodes to "comm (pid N)" by walking
// /proc/<pid>/fd. Unreadable processes are skipped.
func socketOwners(procDir string, inodes map[string]bool) map[string]string {
	owners := map[string]string{}
	entries, err := os.ReadDir(procDir)
	if err != nil {
		return owners
	}
	for _, e := range entries {
		pid := e.Name()
		if _, err := strconv.Atoi(pid); err != nil {
			continue
		}
		fds, err := os.ReadDir(filepath.Join(procDir, pid, "fd"))
		if err != nil {
			continue
		}
		for _, fd := range fds {
			link, err := os.Readlink(filepath.Join(procDir, pid, "fd", fd.Name()))
			if err != nil {
				continue
			}
			inode, ok := strings.CutPrefix(link, "socket:[")
			if !ok {
				continue
			}
			inode = strings.TrimSuffix(inode, "]")
			if inodes[inode] && owners[inode] == "" {
				comm, _ := os.ReadFile(filepath.Join(procDir, pid, "comm"))
				owners[inode] = strings.TrimSpace(string(comm)) + " (pid " + pid + ")"
			}
		}
	}
	return owners
}

// parseOSRelease reads KEY=value lines of /etc/os-release.
func parseOSRelease(data string) map[string]string {
	out := map[string]string{}
	for line := range strings.SplitSeq(data, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok || strings.HasPrefix(key, "#") {
			continue
		}
		if unq, err := strconv.Unquote(value); err == nil {
			value = unq
		} else {
			value = strings.Trim(value, `'"`)
		}
		out[key] = value
	}
	return out
}

// parseMeminfo returns /proc/meminfo values in bytes.
func parseMeminfo(data string) map[string]uint64 {
	out := map[string]uint64{}
	sc := bufio.NewScanner(strings.NewReader(data))
	for sc.Scan() {
		key, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			continue
		}
		n, err := strconv.ParseUint(f[0], 10, 64)
		if err != nil {
			continue
		}
		if len(f) > 1 && f[1] == "kB" {
			n *= 1024
		}
		out[key] = n
	}
	return out
}

// parseKernel turns "6.8.0-45-generic" into 6, 8.
func parseKernel(release string) (major, minor int, ok bool) {
	parts := strings.SplitN(strings.TrimSpace(release), ".", 3)
	if len(parts) < 2 {
		return 0, 0, false
	}
	major, err1 := strconv.Atoi(parts[0])
	minorText := parts[1]
	if i := strings.IndexFunc(minorText, func(r rune) bool { return r < '0' || r > '9' }); i >= 0 {
		minorText = minorText[:i]
	}
	minor, err2 := strconv.Atoi(minorText)
	return major, minor, err1 == nil && err2 == nil
}

// parseDockerVersion turns "28.0.1" or "27.5.1-ce" into 28, 0.
func parseDockerVersion(v string) (major, minor int, ok bool) {
	return parseKernel(v)
}

// ufwAllows reports whether `ufw status` output allows port (any rule
// whose "To" column names the port, alone or with /tcp, or a matching
// application profile).
func ufwAllows(status string, port int) bool {
	p := strconv.Itoa(port)
	names := map[int][]string{80: {"www", "http", "nginx http", "apache", "nginx full", "apache full"}, 443: {"www secure", "https", "nginx https", "apache secure", "nginx full", "apache full"}}
	for line := range strings.SplitSeq(strings.ToLower(status), "\n") {
		if !strings.Contains(line, "allow") {
			continue
		}
		to := strings.TrimSpace(strings.Split(line, "allow")[0])
		to = strings.TrimSuffix(strings.TrimSpace(strings.TrimSuffix(to, "(v6)")), "/tcp")
		for _, part := range strings.Split(to, ",") {
			part = strings.TrimSuffix(strings.TrimSpace(part), "/tcp")
			if part == p {
				return true
			}
			if lo, hi, ok := strings.Cut(part, ":"); ok {
				l, e1 := strconv.Atoi(lo)
				h, e2 := strconv.Atoi(hi)
				if e1 == nil && e2 == nil && l <= port && port <= h {
					return true
				}
			}
		}
		for _, n := range names[port] {
			if to == n {
				return true
			}
		}
	}
	return false
}

// firewalldAllows reports whether `firewall-cmd --list-all` output opens
// port through a service or a port rule.
func firewalldAllows(listAll string, port int) bool {
	service := map[int]string{80: "http", 443: "https"}[port]
	for line := range strings.SplitSeq(listAll, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok {
			continue
		}
		for _, f := range strings.Fields(value) {
			switch key {
			case "services":
				if f == service {
					return true
				}
			case "ports":
				if f == strconv.Itoa(port)+"/tcp" {
					return true
				}
			}
		}
	}
	return false
}
