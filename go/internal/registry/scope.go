package registry

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// maxHeaderBytes bounds one request's line and headers.
const maxHeaderBytes = 1 << 20

// scopePolicy is what one node may do in the registry (RegistryScope).
// Repositories are service ids.
type scopePolicy struct {
	node       string
	pull, push map[string]bool
}

func newScopePolicy(s *agentv1.RegistryScope) *scopePolicy {
	p := &scopePolicy{node: s.GetNodeId(), pull: map[string]bool{}, push: map[string]bool{}}
	for _, r := range s.GetPull() {
		p.pull[r] = true
	}
	for _, r := range s.GetPush() {
		p.push[r] = true
	}
	return p
}

func (p *scopePolicy) canPull(repo string) bool { return p.pull[repo] || p.push[repo] }

// check returns "" when the request may pass, else why not. A blob mount
// from a repository the node may not read is stripped from the request
// (the registry then starts a plain upload).
func (p *scopePolicy) check(r *http.Request) string {
	path := r.URL.Path
	if r.URL.RawPath != "" || strings.Contains(path, "..") || strings.Contains(path, "//") {
		return "malformed path"
	}
	get := r.Method == http.MethodGet || r.Method == http.MethodHead
	if path == "/v2/" || path == "/v2" {
		if get {
			return ""
		}
		return "method not allowed"
	}
	rest, ok := strings.CutPrefix(path, "/v2/")
	if !ok {
		return "not a registry API path"
	}
	seg := strings.Split(rest, "/")
	if len(seg) < 3 {
		return "not allowed for nodes" // _catalog and anything unknown
	}
	repo, kind := seg[0], seg[1]
	need := func(ok bool) string {
		if ok {
			return ""
		}
		return fmt.Sprintf("this node may not %s repository %q", map[bool]string{true: "read", false: "write"}[get], repo)
	}
	switch {
	case kind == "manifests" && len(seg) == 3:
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			return need(p.canPull(repo))
		case http.MethodPut:
			return need(p.push[repo])
		}
	case kind == "blobs" && len(seg) == 3 && seg[2] != "uploads":
		if get {
			return need(p.canPull(repo))
		}
	case kind == "blobs" && len(seg) == 4 && seg[2] == "uploads":
		if seg[3] == "" {
			if r.Method != http.MethodPost {
				break
			}
			if reason := need(p.push[repo]); reason != "" {
				return reason
			}
			p.stripForeignMount(r)
			return ""
		}
		switch r.Method {
		case http.MethodGet, http.MethodPatch, http.MethodPut, http.MethodDelete:
			// Upload sessions only: cancelling one deletes no content.
			return need(p.push[repo])
		}
	case kind == "tags" && len(seg) == 3 && seg[2] == "list", kind == "referrers" && len(seg) == 3:
		if get {
			return need(p.canPull(repo))
		}
	}
	return "not allowed for nodes"
}

// stripForeignMount drops ?mount=&from= unless the node may read from.
// A mount without from (any repository) is dropped too.
func (p *scopePolicy) stripForeignMount(r *http.Request) {
	q := r.URL.Query()
	if !q.Has("mount") && !q.Has("from") {
		return
	}
	if from := q.Get("from"); from != "" && q.Get("mount") != "" && p.canPull(from) {
		return
	}
	q.Del("mount")
	q.Del("from")
	r.URL.RawQuery = q.Encode()
}

// headerLimit counts bytes while a request's headers are read.
type headerLimit struct {
	r io.Reader
	n int64 // < 0: no limit
}

func (l *headerLimit) Read(p []byte) (int, error) {
	if l.n < 0 {
		return l.r.Read(p)
	}
	if l.n == 0 {
		return 0, errHeaderTooLarge
	}
	if int64(len(p)) > l.n {
		p = p[:l.n]
	}
	n, err := l.r.Read(p)
	l.n -= int64(n)
	return n, err
}

var errHeaderTooLarge = errors.New("request headers too large")

// serveScoped serves one relayed node connection as HTTP/1.1 instead of
// raw bytes: every request is read here, checked against the node's
// scope (never DELETE of content, never the catalog, only the node's own
// repositories) and only then written to the registry. The node cannot
// get around it, because this runs on the panel's node.
func (t *Tunnel) serveScoped(ctx context.Context, scope *agentv1.RegistryScope, s rpc.RawStream) error {
	pol := newScopePolicy(scope)
	log := t.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	limit := &headerLimit{r: s}
	br := bufio.NewReaderSize(limit, 32<<10)
	bw := bufio.NewWriterSize(s, 32<<10)
	up := &upstream{}
	defer up.close()
	// Unblocks a registry read when the panel cancels.
	stop := context.AfterFunc(ctx, up.close)
	defer stop()

	for {
		limit.n = maxHeaderBytes
		if first, err := br.Peek(1); err == nil && first[0] == 0x16 {
			// A TLS handshake: Docker tries HTTPS first and falls back to
			// HTTP on an HTTP answer, as from the registry itself.
			writeRegistryError(bw, http.StatusBadRequest, "UNSUPPORTED", "this registry speaks plain HTTP")
			return nil
		}
		req, err := http.ReadRequest(br)
		limit.n = -1
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || ctx.Err() != nil {
				return nil // the node closed the connection
			}
			writeRegistryError(bw, http.StatusBadRequest, "UNSUPPORTED", "bad request")
			return nil
		}
		if reason := pol.check(req); reason != "" {
			log.Warn("registry request refused", "node_id", pol.node, "method", req.Method, "path", req.URL.Path, "reason", reason)
			writeRegistryError(bw, http.StatusForbidden, "DENIED", reason)
			return nil // the body was not read: close rather than drain it
		}
		if strings.EqualFold(req.Header.Get("Expect"), "100-continue") {
			req.Header.Del("Expect")
			if _, err := bw.WriteString("HTTP/1.1 100 Continue\r\n\r\n"); err != nil {
				return nil
			}
			if err := bw.Flush(); err != nil {
				return nil
			}
		}
		resp, err := t.forward(ctx, req, up)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			log.Warn("registry unreachable", "node_id", pol.node, "err", err)
			return rpc.NewError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, "the registry is not reachable")
		}
		werr := resp.Write(bw)
		_ = resp.Body.Close()
		if werr == nil {
			werr = bw.Flush()
		}
		if werr != nil || resp.Close || req.Close {
			return nil
		}
	}
}

// upstream is the registry connection of one relayed connection.
type upstream struct {
	mu     sync.Mutex
	c      net.Conn
	r      *bufio.Reader
	closed bool
}

// get returns the kept connection, dialing one when there is none.
func (u *upstream) get(ctx context.Context, dial func(context.Context) (net.Conn, error)) (net.Conn, *bufio.Reader, bool, error) {
	u.mu.Lock()
	c, r, closed := u.c, u.r, u.closed
	u.mu.Unlock()
	if closed {
		return nil, nil, false, net.ErrClosed
	}
	if c != nil {
		return c, r, true, nil
	}
	c, err := dial(ctx)
	if err != nil {
		return nil, nil, false, err
	}
	r = bufio.NewReaderSize(c, 32<<10)
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		_ = c.Close()
		return nil, nil, false, net.ErrClosed
	}
	u.c, u.r = c, r
	return c, r, false, nil
}

// drop closes the kept connection after an error.
func (u *upstream) drop() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.c != nil {
		_ = u.c.Close()
		u.c, u.r = nil, nil
	}
}

func (u *upstream) close() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.closed = true
	if u.c != nil {
		_ = u.c.Close()
		u.c, u.r = nil, nil
	}
}

// forward writes req to the registry and reads its answer. A request
// without a body is sent again on a fresh connection when a kept one
// turned out closed.
func (t *Tunnel) forward(ctx context.Context, req *http.Request, up *upstream) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		c, r, reused, err := up.get(ctx, t.Dial.DialRegistry)
		if err != nil {
			return nil, err
		}
		err = req.Write(c)
		var resp *http.Response
		if err == nil {
			resp, err = http.ReadResponse(r, req)
		}
		if err == nil {
			return resp, nil
		}
		up.drop()
		noBody := req.Body == nil || req.Body == http.NoBody
		if !reused || attempt > 0 || !noBody {
			return nil, err
		}
	}
}

func writeRegistryError(w *bufio.Writer, status int, code, msg string) {
	body := fmt.Sprintf(`{"errors":[{"code":%q,"message":%q}]}`+"\n", code, msg)
	resp := &http.Response{
		StatusCode: status, ProtoMajor: 1, ProtoMinor: 1, Close: true,
		Header:        http.Header{"Content-Type": {"application/json"}},
		ContentLength: int64(len(body)), Body: io.NopCloser(strings.NewReader(body)),
	}
	_ = resp.Write(w)
	_ = w.Flush()
}
