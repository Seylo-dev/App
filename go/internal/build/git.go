package build

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// knownHosts are the published SSH host keys of the big git hosts, used
// when the panel sends no ssh_known_hosts. Other hosts need explicit keys:
// trusting a key on first use would let a network attacker read the
// repository and the deploy key's access.
const knownHosts = `github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf
gitlab.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFSMqzJeV9rUzU4kWitGjeR4PWSa29SPqJ1fVkhtj3Hw9xjLVXVYrU9QlYWrOLXBpQ6KWjbjTDTdDkoohFzgbEY=
gitlab.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCsj2bNKTBSpIYDEGk9KxsGh3mySTRgMtXL583qmBpzeQ+jqCMRgBqB98u3z++J1sKlXHWfM9dyhSevkMwSbhoR8XIq/U0tCNyokEi/ueaBMCvbcTHhO7FcwzY92WK4Yt0aGROY5qX2UKSeOvuP4D6TPqKF1onrSzH9bx9XUf2lEdWT/ia1NEKjunUqu1xOB/StKDHMoX4/OKyIzuS0q/T1zOATthvasJFoPrAjkohTyaDUz2LN5JoH839hViyEG82yB+MjcFV5MU3N1l1QL3cVUCh93xSaua1N85qivl+siMkPGbO5xR/En4iEY6K2XPASUEMaieWVNTRCtJ4S8H+9
bitbucket.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO
bitbucket.org ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBPIQmuzMBuKdWeF4+a2sjSSpBK0iqitSQ+5BM9KhpexuGt20JpTVM7u5BDZngncgrqDMbWdxMWWOGtZ9UgbqgZE=
bitbucket.org ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDQeJzhupRu0u0cdegZIa8e86EG2qOCsIsD1Xw0xSeiPDlCr7kq97NLmMbpKTX6Esc30NuoqEEHCuc7yWtwp8dI76EEEB1VqY9QJq6vk+aySyboD5QF61I/1WeTwu+deCbgKMGbUijeXhtfbxSxm6JwGrXrhBdofTsbKRUsrN1WoNgUa8uqN1Vx6WAJw1JHPhglEGGHea6QICwJOAr/6mrui/oB7pkaWKHj3z7d1IC4KWLtY47elvjbaTlkN04Kc/5LFEirorGYVbt15kAUlqGM65pk6ZBxtaO3+30LVlORZkxOh+LKL/BvbZ/iRNhItLqNyieoQj/uh/7Iv4uyH/cV/0b4WDSd3DptigWq84lJubb9t/DnZlrJazxyDCulTmKdOR7vs9gMTo+uoIrPSb8ScTtvw65+odKAlBj59dhnVp9zd7QUojOpXlL62Aw56U4oO+FALuevvMjiWeavKhJqlR7i5n9srYcrNV7ttmDw7kf/97P5zauIhxcjX+xHv4M=
`

// The credential helper reads the token from the command's environment,
// so it never appears in a URL, the process list or .git/config. It is
// installed for the source's own origin only (credential.<origin>.helper)
// and answers only when git asks for that host (BUILD_GIT_HOST), so a
// submodule or a redirect to another host never receives the token.
const credentialHelper = `!f() { test "$1" = get || exit 0; h=; while IFS= read -r l; do case $l in host=*) h=${l#host=} ;; esac; done; ` +
	`test -n "$h" && test "$h" = "$BUILD_GIT_HOST" || exit 0; echo "username=${BUILD_GIT_USER}"; echo "password=${BUILD_GIT_TOKEN}"; }; f`

// ErrFetch is a source that could not be fetched (bad address, branch,
// commit or credentials).
var ErrFetch = errors.New("fetching the source failed")

// git runs git commands for one checkout with the build's credentials.
// Every connection goes through proxy (gitproxy.go); close stops it.
type git struct {
	run   Runner
	log   io.Writer
	env   []string
	args  []string
	proxy *gitProxy
}

// proxyEnv clears the proxy variables the agent passes to commands
// (exec.go passEnv): git must use the fetch's own proxy, and NO_PROXY
// would let a host skip it.
var proxyEnv = []string{"HTTP_PROXY=", "HTTPS_PROXY=", "ALL_PROXY=", "NO_PROXY=", "http_proxy=", "https_proxy=", "all_proxy=", "no_proxy="}

// newGit prepares credentials in work (a private folder of the build) and
// starts the fetch's proxy. The caller closes it.
func newGit(r Runner, log io.Writer, src *agentv1.GitSource, work string) (*git, error) {
	policy, err := gitPolicyFor(src)
	if err != nil {
		return nil, err
	}
	home := filepath.Join(work, "home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		return nil, err
	}
	log = &syncWriter{w: log}
	proxy, err := startGitProxy(policy, log)
	if err != nil {
		return nil, err
	}
	g := &git{
		run:   r,
		log:   log,
		proxy: proxy,
		env: append([]string{
			"HOME=" + home,
			"GIT_TERMINAL_PROMPT=0",
			"GIT_CONFIG_NOSYSTEM=1",
			"GIT_CONFIG_GLOBAL=/dev/null",
			"GIT_ASKPASS=/bin/false",
			"SSH_ASKPASS=/bin/false",
			"LC_ALL=C",
		}, proxyEnv...),
		args: []string{
			"-c", "protocol.allow=never",
			"-c", "protocol.https.allow=always",
			// Plain http only when an admin allowed it, never with
			// credentials; otherwise not even through a redirect.
			"-c", "protocol.http.allow=" + httpAllow(src),
			// ssh only with the source's key: without one, ssh would use
			// whatever keys and config the node's root user has.
			"-c", "protocol.ssh.allow=" + sshAllow(src),
			"-c", "core.hooksPath=/dev/null",
			"-c", "advice.detachedHead=false",
			"-c", "credential.helper=",
			// http and https, redirects and submodules included.
			"-c", "http.proxy=" + proxy.URL(),
		},
	}
	ok := false
	defer func() {
		if !ok {
			g.close()
		}
	}()
	if src.GetToken() != "" {
		origin, host, err := gitOrigin(src.GetUrl())
		if err != nil {
			return nil, err
		}
		g.args = append(g.args, "-c", "credential."+origin+".helper="+credentialHelper)
		g.env = append(g.env, "BUILD_GIT_HOST="+host, "BUILD_GIT_USER="+gitUser(src), "BUILD_GIT_TOKEN="+src.GetToken())
	}
	if key := src.GetSshPrivateKey(); key != "" {
		dir := filepath.Join(work, "ssh")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
		keyFile := filepath.Join(dir, "id")
		if !strings.HasSuffix(key, "\n") {
			key += "\n"
		}
		if err := os.WriteFile(keyFile, []byte(key), 0o600); err != nil {
			return nil, err
		}
		hosts := src.GetSshKnownHosts()
		if strings.TrimSpace(hosts) == "" {
			hosts = knownHosts
		}
		hostsFile := filepath.Join(dir, "known_hosts")
		if err := os.WriteFile(hostsFile, []byte(hosts+"\n"), 0o600); err != nil {
			return nil, err
		}
		dial, err := gitDialProxyCommand(proxy.Addr(), policy.source.String())
		if err != nil {
			return nil, err
		}
		g.env = append(g.env, "GIT_SSH_COMMAND=ssh -F /dev/null -i "+shellQuote(keyFile)+
			" -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=yes"+
			" -o UserKnownHostsFile="+shellQuote(hostsFile)+" -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=30"+
			" -o CheckHostIP=no -o "+shellQuote("ProxyCommand="+dial))
	}
	ok = true
	return g, nil
}

// gitDialProxyCommand is ssh's ProxyCommand: this binary's git-dial with
// the proxy and the source's own host:port spelled out (no %h: ssh puts
// that into a shell command line, and a submodule URL could hold shell
// syntax).
func gitDialProxyCommand(proxy, target string) (string, error) {
	exe, err := gitDialProgram()
	if err != nil {
		return "", fmt.Errorf("finding the agent binary for ssh: %w", err)
	}
	// ssh expands %-tokens in the whole command before the shell sees it.
	for _, part := range []string{exe, proxy, target} {
		if strings.ContainsAny(part, "%\n\r\x00") {
			return "", fmt.Errorf("%q cannot be used in an ssh ProxyCommand", part)
		}
	}
	return shellQuote(exe) + " " + GitDialCommand + " " + shellQuote(proxy) + " " + shellQuote(target), nil
}

// close stops the fetch's proxy.
func (g *git) close() {
	if g.proxy != nil {
		g.proxy.Close()
	}
}

// sshAllow is git's protocol.ssh.allow: only a source with an SSH key
// uses ssh.
func sshAllow(src *agentv1.GitSource) string {
	if src.GetSshPrivateKey() == "" {
		return "never"
	}
	return "always"
}

// defaultGitUser is the HTTPS user name sent with a token when the panel
// names none: GitHub wants it, GitLab and Gitea take any name.
const defaultGitUser = "x-access-token"

// gitUser is the user name the credential helper answers with the token
// (Bitbucket access tokens need "x-token-auth", app passwords the account).
func gitUser(src *agentv1.GitSource) string {
	if u := src.GetUsername(); u != "" {
		return u
	}
	return defaultGitUser
}

// httpAllow is git's protocol.http.allow for src: "always" only for a
// source the panel marks allow_plain_http (an admin's choice) without a
// token or key; otherwise "never", which also stops an https:// server
// redirecting the clone to http:// (validateGitURL refuses the address).
func httpAllow(src *agentv1.GitSource) string {
	if !src.GetAllowPlainHttp() || src.GetToken() != "" || src.GetSshPrivateKey() != "" {
		return "never"
	}
	return "always"
}

// gitOrigin is the scheme://host[:port] of an http(s) repository address
// (the credential.<url> config key) and the host[:port] git names in its
// credential requests.
func gitOrigin(raw string) (origin, host string, err error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return "", "", invalid("an access token needs an https:// repository address")
	}
	return u.Scheme + "://" + u.Host, u.Host, nil
}

func (g *git) cmd(dir string, args ...string) Cmd {
	all := append([]string{}, g.args...)
	if dir != "" {
		all = append(all, "-C", dir)
	}
	return Cmd{Name: "git", Args: append(all, args...), Env: g.env, Stdout: g.log, Stderr: g.log}
}

func (g *git) do(ctx context.Context, dir string, args ...string) error {
	return g.run.Run(ctx, g.cmd(dir, args...))
}

// fetchGit checks out src into dir: the exact commit when given, else
// the tip of ref (or the default branch). Shallow wherever the server
// allows it.
func fetchGit(ctx context.Context, r Runner, log io.Writer, src *agentv1.GitSource, dir, work string, submodules bool) (*agentv1.BuildSourceInfo, error) {
	g, err := newGit(r, log, src, work)
	if err != nil {
		return nil, fmt.Errorf("preparing git credentials: %w", err)
	}
	defer g.close()
	// The fetch's proxy writes to the log from its own goroutines: one lock for every write.
	log = g.log
	if err := g.do(ctx, "", "init", "-q", dir); err != nil {
		return nil, fmt.Errorf("git init: %w", err)
	}
	if err := g.do(ctx, dir, "remote", "add", "origin", src.GetUrl()); err != nil {
		return nil, fmt.Errorf("git remote add: %w", err)
	}
	ref := src.GetRef()
	if ref == "" {
		ref = "HEAD"
	}
	commit := src.GetCommit()
	fmt.Fprintf(log, "Fetching %s (%s)\n", redactURL(src.GetUrl()), describeRev(ref, commit))

	target := "FETCH_HEAD"
	switch {
	case commit == "":
		if err := g.do(ctx, dir, "fetch", "-q", "--depth", "1", "--no-tags", "origin", ref); err != nil {
			return nil, g.fetchErr(ctx, err, "could not fetch %s - check the address, the branch and the credentials", ref)
		}
	default:
		target = commit
		// Most hosts serve a commit by id; others only reachable refs.
		if err := g.do(ctx, dir, "fetch", "-q", "--depth", "1", "--no-tags", "origin", commit); err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if refused := g.proxy.Refused(); refused != nil {
				return nil, refused
			}
			fmt.Fprintf(log, "The server does not serve commits by id, fetching %s instead\n", ref)
			if err := g.do(ctx, dir, "fetch", "-q", "--no-tags", "origin", ref); err != nil {
				return nil, g.fetchErr(ctx, err, "could not fetch %s - check the address, the branch and the credentials", ref)
			}
		}
	}
	if err := g.do(ctx, dir, "checkout", "-q", "--detach", target); err != nil {
		return nil, g.fetchErr(ctx, err, "commit %s is not on %s", short(commit), ref)
	}
	if submodules {
		if err := g.do(ctx, dir, "submodule", "update", "-q", "--init", "--recursive", "--depth", "1"); err != nil {
			return nil, g.fetchErr(ctx, err, "could not fetch the submodules")
		}
	}

	out, err := output(ctx, r, g.cmd(dir, "log", "-1", "--format=%H%x00%s%x00%an"))
	if err != nil {
		return nil, fmt.Errorf("reading the commit: %w", err)
	}
	parts := strings.SplitN(out, "\x00", 3)
	info := &agentv1.BuildSourceInfo{Commit: parts[0]}
	if len(parts) == 3 {
		info.Subject, info.Author = parts[1], parts[2]
	}
	if commit != "" && !strings.HasPrefix(info.Commit, commit) {
		return nil, fmt.Errorf("%w: checked out %s instead of %s", ErrFetch, short(info.Commit), short(commit))
	}
	fmt.Fprintf(log, "At %s %s\n", short(info.Commit), info.Subject)
	return info, nil
}

// fetchErr is a failed git command: the connection the proxy refused when
// there was one (that is why it failed), else what the command was for.
func (g *git) fetchErr(ctx context.Context, err error, format string, args ...any) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if refused := g.proxy.Refused(); refused != nil {
		return refused
	}
	return fmt.Errorf("%w: %s (%v)", ErrFetch, fmt.Sprintf(format, args...), err)
}

func describeRev(ref, commit string) string {
	if commit == "" {
		return ref
	}
	return ref + " at " + short(commit)
}

func short(commit string) string {
	if len(commit) > 7 {
		return commit[:7]
	}
	return commit
}

// redactURL drops anything that looks like credentials from an address
// before it is logged.
func redactURL(u string) string {
	if i := strings.Index(u, "://"); i >= 0 {
		rest := u[i+3:]
		if at := strings.IndexByte(rest, '@'); at >= 0 && at < strings.IndexAny(rest+"/", "/") {
			return u[:i+3] + "***@" + rest[at+1:]
		}
	}
	return u
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
