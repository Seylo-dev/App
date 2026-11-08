package tailnet

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"syscall"
	"time"
)

// DefaultSocket is where tailscaled listens on Linux. config.yml's
// tailscale_socket overrides it.
const DefaultSocket = "/var/run/tailscale/tailscaled.sock"

// localAPIHost is the only Host tailscaled's LocalAPI accepts over its
// socket (tailscale's apitype.LocalAPIHost). It refuses requests with an
// Origin or a Referer, which this client never sends.
const localAPIHost = "local-tailscaled.sock"

// RequestTimeout bounds every LocalAPI request.
const RequestTimeout = 5 * time.Second

// maxBody caps what the client reads of an answer. Status without peers
// and the Serve config are a few KiB.
const maxBody = 4 << 20

var (
	// ErrNoTailscaled means nothing answers on the socket: tailscaled is not
	// installed, or not running.
	ErrNoTailscaled = errors.New("tailscaled is not running on this server")
	// ErrETagMismatch is tailscaled's 412: the Serve config changed after it
	// was read. Read it again and redo the change.
	ErrETagMismatch = errors.New("the Serve config changed while it was being written")
)

// HTTPError is a LocalAPI answer that is not a success.
type HTTPError struct {
	// Endpoint is the LocalAPI path, for example "serve-config".
	Endpoint string
	Code     int
	// Message is tailscaled's error text, cut to 300 characters.
	Message string
}

func (e *HTTPError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("tailscaled %s answered %d", e.Endpoint, e.Code)
	}
	return fmt.Sprintf("tailscaled %s answered %d: %s", e.Endpoint, e.Code, e.Message)
}

// Client talks to tailscaled's LocalAPI over its unix socket. It never
// uses the agent's HTTP proxy and never follows redirects.
type Client struct {
	socket string
	hc     *http.Client
}

// NewClient returns a client for the socket; "" is DefaultSocket.
func NewClient(socket string) *Client {
	if socket == "" {
		socket = DefaultSocket
	}
	var dialer net.Dialer
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", socket)
		},
		DisableCompression: true,
		MaxIdleConns:       2,
		IdleConnTimeout:    30 * time.Second,
	}
	return &Client{socket: socket, hc: &http.Client{
		Transport:     tr,
		Timeout:       RequestTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// Socket is the socket path the client dials.
func (c *Client) Socket() string { return c.socket }

// Status is the part of tailscaled's ipnstate.Status the agent reads.
type Status struct {
	// Version is tailscaled's long version, for example
	// "1.104.5-t1a2b3c4d5-g6e7f8a9b0".
	Version string
	// BackendState is "NoState", "NeedsLogin", "NeedsMachineAuth",
	// "Stopped", "Starting" or "Running".
	BackendState string
	// AuthURL is the interactive sign-in link while a login waits for it.
	// A secret: never log it.
	AuthURL      string
	HaveNodeKey  bool
	TailscaleIPs []string
	Self         *PeerStatus
	// ExitNodeStatus is set while traffic goes through an exit node.
	ExitNodeStatus *ExitNodeStatus `json:",omitempty"`
	MagicDNSSuffix string
	CurrentTailnet *TailnetStatus
	// CertDomains are the names the tailnet issues HTTPS certificates for;
	// empty when HTTPS is off for the tailnet.
	CertDomains []string
	// User maps user ids (as JSON object keys) to profiles.
	User map[string]UserProfile
}

// PeerStatus is the part of ipnstate.PeerStatus the agent reads (Self).
type PeerStatus struct {
	ID       string
	HostName string
	// DNSName is the MagicDNS name with a trailing dot.
	DNSName       string
	UserID        int64
	TailscaleIPs  []string
	Tags          []string   `json:",omitempty"`
	PrimaryRoutes []string   `json:",omitempty"`
	KeyExpiry     *time.Time `json:",omitempty"`
	Expired       bool       `json:",omitempty"`
}

// TailnetStatus is ipnstate.TailnetStatus.
type TailnetStatus struct {
	Name            string
	MagicDNSSuffix  string
	MagicDNSEnabled bool
}

// ExitNodeStatus is ipnstate.ExitNodeStatus.
type ExitNodeStatus struct {
	ID     string
	Online bool
}

// UserProfile is tailcfg.UserProfile.
type UserProfile struct {
	ID          int64
	LoginName   string
	DisplayName string
}

// Prefs is the part of tailscaled's ipn.Prefs the agent reads.
type Prefs struct {
	WantRunning bool
	// CorpDNS is "--accept-dns": the server uses Tailscale DNS.
	CorpDNS         bool
	LoggedOut       bool
	ExitNodeID      string
	ExitNodeIP      string
	AdvertiseRoutes []string
	// Persist is the login profile (private keys are stripped by
	// tailscaled before it answers).
	Persist *Persist `json:"Config"`
}

// Persist is the part of persist.Persist the agent reads.
type Persist struct {
	NodeID      string
	UserProfile UserProfile
}

// SignedInBefore reports whether the current profile has a login: a node
// id or a user from an earlier sign-in (an expired key, for example). A
// server that never signed in, or signed out (tailscaled deletes the
// profile), has none.
func (p *Prefs) SignedInBefore() bool {
	if p == nil || p.Persist == nil {
		return false
	}
	return p.Persist.NodeID != "" || p.Persist.UserProfile.ID != 0 || p.Persist.UserProfile.LoginName != ""
}

// PrefsEdit is a change to tailscaled's prefs. Only these two fields can
// be changed: the agent never touches anything else.
type PrefsEdit struct {
	WantRunning *bool
	CorpDNS     *bool
}

// mask is the MaskedPrefs JSON: each set field plus its <Field>Set flag,
// nothing else.
func (e PrefsEdit) mask() map[string]bool {
	m := map[string]bool{}
	if e.WantRunning != nil {
		m["WantRunning"], m["WantRunningSet"] = *e.WantRunning, true
	}
	if e.CorpDNS != nil {
		m["CorpDNS"], m["CorpDNSSet"] = *e.CorpDNS, true
	}
	return m
}

// Status reads tailscaled's status without the peer list.
func (c *Client) Status(ctx context.Context) (*Status, error) {
	_, body, err := c.do(ctx, http.MethodGet, "status?peers=false", nil, nil)
	if err != nil {
		return nil, err
	}
	st := &Status{}
	if err := json.Unmarshal(body, st); err != nil {
		return nil, fmt.Errorf("reading tailscaled's status: %w", err)
	}
	return st, nil
}

// Prefs reads tailscaled's prefs.
func (c *Client) Prefs(ctx context.Context) (*Prefs, error) {
	_, body, err := c.do(ctx, http.MethodGet, "prefs", nil, nil)
	if err != nil {
		return nil, err
	}
	return decodePrefs(body)
}

// EditPrefs changes the fields edit sets and returns the new prefs.
func (c *Client) EditPrefs(ctx context.Context, edit PrefsEdit) (*Prefs, error) {
	mask := edit.mask()
	if len(mask) == 0 {
		return nil, errors.New("tailnet: EditPrefs with nothing to change")
	}
	b, err := json.Marshal(mask)
	if err != nil {
		return nil, err
	}
	_, body, err := c.do(ctx, http.MethodPatch, "prefs", b, http.Header{"Content-Type": {"application/json"}})
	if err != nil {
		return nil, err
	}
	return decodePrefs(body)
}

func decodePrefs(body []byte) (*Prefs, error) {
	p := &Prefs{}
	if err := json.Unmarshal(body, p); err != nil {
		return nil, fmt.Errorf("reading tailscaled's prefs: %w", err)
	}
	return p, nil
}

// LoginInteractive asks tailscaled for an interactive sign-in. The link
// shows up in Status.AuthURL once the control server sent it.
func (c *Client) LoginInteractive(ctx context.Context) error {
	_, _, err := c.do(ctx, http.MethodPost, "login-interactive", nil, nil)
	return err
}

// GetServeConfig returns tailscaled's Serve config as it sent it (JSON,
// possibly "null") and its ETag.
func (c *Client) GetServeConfig(ctx context.Context) (raw []byte, etag string, err error) {
	resp, body, err := c.do(ctx, http.MethodGet, "serve-config", nil, nil)
	if err != nil {
		return nil, "", err
	}
	return body, resp.Header.Get("Etag"), nil
}

// SetServeConfig replaces the Serve config if it still has etag
// (If-Match). ErrETagMismatch means it changed in between.
func (c *Client) SetServeConfig(ctx context.Context, raw []byte, etag string) error {
	h := http.Header{"Content-Type": {"application/json"}}
	if etag != "" {
		h.Set("If-Match", etag)
	}
	_, _, err := c.do(ctx, http.MethodPost, "serve-config", raw, h)
	var he *HTTPError
	if errors.As(err, &he) && he.Code == http.StatusPreconditionFailed {
		return ErrETagMismatch
	}
	return err
}

// UpdateServe reads the Serve config, applies edit and writes the result
// when edit changed something, trying again up to attempts times when
// tailscaled answers 412. It returns edit's last result.
func (c *Client) UpdateServe(ctx context.Context, attempts int, edit func(raw []byte) (Change, error)) (Change, error) {
	for i := 0; ; i++ {
		raw, etag, err := c.GetServeConfig(ctx)
		if err != nil {
			return Change{}, err
		}
		ch, err := edit(raw)
		if err != nil || ch.Config == nil {
			return ch, err
		}
		err = c.SetServeConfig(ctx, ch.Config, etag)
		if !errors.Is(err, ErrETagMismatch) || i+1 >= attempts {
			return ch, err
		}
	}
}

// do sends one LocalAPI request and reads the whole answer.
func (c *Client) do(ctx context.Context, method, endpoint string, body []byte, header http.Header) (*http.Response, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://"+localAPIHost+"/localapi/v0/"+endpoint, rd)
	if err != nil {
		return nil, nil, err
	}
	for k, v := range header {
		req.Header[k] = v
	}
	name, _, _ := strings.Cut(endpoint, "?")
	resp, err := c.hc.Do(req)
	if err != nil {
		if noDaemon(err) {
			return nil, nil, fmt.Errorf("%w (nothing answers on %s)", ErrNoTailscaled, c.socket)
		}
		if ctx.Err() != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, nil, fmt.Errorf("tailscaled %s did not answer within %s", name, RequestTimeout)
		}
		return nil, nil, fmt.Errorf("asking tailscaled (%s): %w", name, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return nil, nil, fmt.Errorf("reading tailscaled's %s answer: %w", name, err)
	}
	if len(b) > maxBody {
		return nil, nil, fmt.Errorf("tailscaled's %s answer is larger than %d bytes", name, maxBody)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return resp, b, &HTTPError{Endpoint: name, Code: resp.StatusCode, Message: errorText(b)}
	}
	return resp, b, nil
}

// noDaemon reports a dial error that means no tailscaled: no socket file,
// or a socket nobody listens on.
func noDaemon(err error) bool {
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED)
}

// errorText is tailscaled's error message: {"error": "..."} or plain text.
func errorText(b []byte) string {
	var j struct {
		Error string `json:"error"`
	}
	msg := strings.TrimSpace(string(b))
	if json.Unmarshal(b, &j) == nil && j.Error != "" {
		msg = j.Error
	}
	msg = strings.Join(strings.Fields(msg), " ")
	if len(msg) > 300 {
		msg = strings.ToValidUTF8(msg[:300], "")
	}
	return msg
}
