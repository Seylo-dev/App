package agent

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"
)

// osName reads /etc/os-release: "ubuntu 24.04".
func osName() string {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return "linux"
	}
	defer f.Close()
	vals := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if ok {
			vals[k] = strings.Trim(v, `"'`)
		}
	}
	name := strings.TrimSpace(vals["ID"] + " " + vals["VERSION_ID"])
	if name == "" {
		return "linux"
	}
	return name
}

func kernelRelease() string {
	var u syscall.Utsname
	if err := syscall.Uname(&u); err != nil {
		return ""
	}
	b := make([]byte, 0, len(u.Release))
	for _, c := range u.Release {
		if c == 0 {
			break
		}
		b = append(b, byte(c))
	}
	return string(b)
}

func memoryTotal() uint64 {
	var info syscall.Sysinfo_t
	if err := syscall.Sysinfo(&info); err != nil {
		return 0
	}
	return uint64(info.Totalram) * uint64(info.Unit)
}

// bootTime reads btime from /proc/stat.
func bootTime() *timestamppb.Timestamp {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return nil
	}
	for line := range strings.SplitSeq(string(b), "\n") {
		if rest, ok := strings.CutPrefix(line, "btime "); ok {
			if sec, err := strconv.ParseInt(strings.TrimSpace(rest), 10, 64); err == nil {
				return timestamppb.New(time.Unix(sec, 0))
			}
		}
	}
	return nil
}
