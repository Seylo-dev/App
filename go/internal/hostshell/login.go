package hostshell

import (
	"bufio"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// login is who the shell runs as and how it starts.
type login struct {
	user, home, shell string
}

// fallbackShells are tried when passwd names no usable shell.
var fallbackShells = []string{"/bin/bash", "/bin/sh"}

// noLogin are shells that refuse interactive logins.
var noLogin = map[string]bool{"/usr/sbin/nologin": true, "/sbin/nologin": true, "/bin/false": true, "/usr/bin/false": true}

// loginFor reads the passwd entry of uid: name, home and login shell. A
// missing entry or a nologin shell falls back to bash or sh, and a missing
// home to "/".
func loginFor(passwd string, uid int) (login, error) {
	l := login{user: strconv.Itoa(uid), home: "/"}
	if uid == 0 {
		l.user, l.home = "root", "/root"
	}
	if f, err := os.Open(passwd); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			fields := strings.Split(sc.Text(), ":")
			if len(fields) < 7 || fields[2] != strconv.Itoa(uid) {
				continue
			}
			l.user, l.home, l.shell = fields[0], fields[5], fields[6]
			break
		}
		_ = f.Close()
	} else if !errors.Is(err, fs.ErrNotExist) {
		return l, fmt.Errorf("reading %s: %w", passwd, err)
	}
	if l.shell == "" || noLogin[l.shell] || !executable(l.shell) {
		l.shell = ""
		for _, sh := range fallbackShells {
			if executable(sh) {
				l.shell = sh
				break
			}
		}
		if l.shell == "" {
			return l, errors.New("no shell found on this node (tried the passwd entry, /bin/bash and /bin/sh)")
		}
	}
	if st, err := os.Stat(l.home); err != nil || !st.IsDir() {
		l.home = "/"
	}
	return l, nil
}

func executable(path string) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir() && st.Mode()&0o111 != 0
}

// argv0 is the login shell convention: "-bash" for /bin/bash.
func (l login) argv0() string { return "-" + filepath.Base(l.shell) }

// env is the shell's whole environment: nothing of the agent's.
func (l login) env() []string {
	lang := os.Getenv("LANG")
	if lang == "" {
		lang = "C.UTF-8"
	}
	return []string{
		"HOME=" + l.home,
		"USER=" + l.user,
		"LOGNAME=" + l.user,
		"SHELL=" + l.shell,
		"TERM=xterm-256color",
		"LANG=" + lang,
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	}
}
