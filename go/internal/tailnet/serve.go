package tailnet

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	"github.com/seylo-dev/app/go/gen/brand"
)

// ServeEntry is one Serve handler: where it answers and where it proxies.
type ServeEntry struct {
	// HostPort is the Web key, for example "panel.tail1234.ts.net:443".
	HostPort string
	// Path is the mount point, "/" for the panel's entry.
	Path string
	// Proxy is the handler's target, for example
	// "unix:/var/lib/seylo/panel/tailnet.sock".
	Proxy string
}

// Want is the entry the agent keeps in the Serve config.
type Want struct {
	// DNSName is the machine's MagicDNS name without the trailing dot.
	DNSName string
	// HTTPS serves on 443 with the tailnet's certificate; without it the
	// panel is served over HTTP on 80 (the tailnet has no HTTPS).
	HTTPS bool
	// Target is the Proxy value the agent writes (Targets).
	Target string
	// Aliases are other Proxy values that name the same socket; a handler
	// with one of them is the agent's too and is replaced.
	Aliases []string
}

// Port is "443" with HTTPS, else "80".
func (w Want) Port() string {
	if w.HTTPS {
		return "443"
	}
	return "80"
}

// HostPort is the Web key of the entry.
func (w Want) HostPort() string { return w.DNSName + ":" + w.Port() }

// URL is where the panel answers on the tailnet.
func (w Want) URL() string {
	if w.HTTPS {
		return "https://" + w.DNSName
	}
	return "http://" + w.DNSName
}

func (w Want) ours() map[string]bool {
	set := map[string]bool{w.Target: true}
	for _, a := range w.Aliases {
		set[a] = true
	}
	return set
}

// Change is what Ensure or Remove decided.
type Change struct {
	// Config is the Serve config to write; nil when nothing changes.
	Config []byte
	// Conflict says why the entry cannot be added (state CONFLICT).
	Conflict string
	// Entry is the agent's entry in the config after the change, nil when
	// it has none.
	Entry *ServeEntry
}

// PanelSocket is the host path of the panel's tailnet socket. The panel
// container sees <data>/panel at the same path and listens on
// tailnet.sock there.
func PanelSocket(dataRoot string) string {
	return filepath.Join(dataRoot, "panel", "tailnet.sock")
}

// Targets returns the Proxy value to write for socket, and every Proxy
// value that names it (target first). The target has the folder's
// symlinks resolved: tailscaled 1.104.4 and later check a unix backend
// path for symlinks on every dial (TS-2026-016).
func Targets(socket string) (target string, ours []string) {
	plain := "unix:" + filepath.Clean(socket)
	target = plain
	if dir, err := filepath.EvalSymlinks(filepath.Dir(socket)); err == nil {
		target = "unix:" + filepath.Join(dir, filepath.Base(socket))
	}
	ours = []string{target}
	if plain != target {
		ours = append(ours, plain)
	}
	return target, ours
}

// Ensure adds the agent's entry to the Serve config current (tailscaled's
// JSON) or confirms it is there. It is a conflict, and nothing is added,
// while another handler or a foreground `tailscale serve` uses the same
// host and port, or the TCP port serves something else; the agent's entry
// then stays only if it is already there. With AllowFunnel on for that
// host and port the agent's entries are removed: the panel is never on the
// internet. The agent's handlers anywhere else (an old DNS name, the other
// scheme, an alias path) are removed. Keys it does not know survive byte
// for byte, and Config is nil when nothing changed.
func Ensure(current []byte, w Want) (Change, error) {
	if w.DNSName == "" || w.Target == "" {
		return Change{}, errors.New("tailnet: Ensure needs a DNS name and a target")
	}
	d, err := parseServe(current, true)
	if err != nil {
		return Change{}, err
	}
	ours, hp, port := w.ours(), w.HostPort(), w.Port()
	if d.funnelOn(hp) {
		ch := Change{Conflict: fmt.Sprintf("Tailscale Funnel is on for %s, which would put the panel on the internet. "+
			"%s adds no entry there until Funnel is off (tailscale funnel --%s=%s off).", hp, brand.DisplayName, scheme(w.HTTPS), port)}
		if d.removeOurs(ours, nil) {
			d.dropUnusedTCP()
			ch.Config, err = d.encode()
		}
		return ch, err
	}
	if msg := d.conflictAt(hp, port, w.HTTPS, ours); msg != "" {
		return Change{Conflict: msg, Entry: d.entryAt(hp, "/", ours)}, nil
	}
	keep := &ServeEntry{HostPort: hp, Path: "/", Proxy: w.Target}
	changed := d.removeOurs(ours, keep)
	if _, ok := d.tcp[port]; !ok {
		d.tcp[port] = webTCP(w.HTTPS)
		d.tcpDirty, changed = true, true
	}
	wc := d.web[hp]
	if wc == nil {
		wc = &webConfig{rest: map[string]json.RawMessage{}, handlers: map[string]json.RawMessage{}}
		d.web[hp] = wc
	}
	if proxyOf(wc.handlers["/"]) != w.Target {
		wc.handlers["/"] = ourHandler(w.Target)
		wc.dirty, d.webDirty, changed = true, true, true
	}
	d.dropUnusedTCP()
	if !changed {
		return Change{Entry: keep}, nil
	}
	b, err := d.encode()
	return Change{Config: b, Entry: keep}, err
}

// Remove takes the agent's handlers (Proxy one of ours) out of the Serve
// config, then a host whose last handler that was and a TCP port entry no
// host uses any more. Everything else stays. Config is nil when the config
// had none of them.
func Remove(current []byte, ours ...string) (Change, error) {
	d, err := parseServe(current, true)
	if err != nil {
		return Change{}, err
	}
	if !d.removeOurs(toSet(ours), nil) {
		return Change{}, nil
	}
	d.dropUnusedTCP()
	b, err := d.encode()
	return Change{Config: b}, err
}

// Find lists the agent's handlers in the Serve config, sorted.
func Find(current []byte, ours ...string) ([]ServeEntry, error) {
	d, err := parseServe(current, false)
	if err != nil {
		return nil, err
	}
	set := toSet(ours)
	var out []ServeEntry
	for _, hp := range sortedKeys(d.web) {
		for _, mount := range sortedKeys(d.web[hp].handlers) {
			if p := proxyOf(d.web[hp].handlers[mount]); set[p] {
				out = append(out, ServeEntry{HostPort: hp, Path: mount, Proxy: p})
			}
		}
	}
	return out, nil
}

// serveDoc is tailscaled's ServeConfig with only TCP, Web, AllowFunnel and
// Foreground decoded; every other key, and every value the agent does not
// change, is kept as the raw JSON tailscaled sent.
type serveDoc struct {
	top        map[string]json.RawMessage
	tcp        map[string]json.RawMessage
	web        map[string]*webConfig
	funnel     map[string]bool
	foreground []*serveDoc
	// freed are ports of hosts whose last handler Remove took.
	freed              map[string]bool
	tcpDirty, webDirty bool
}

// webConfig is one WebServerConfig: its Handlers by mount point, plus any
// other keys a newer tailscaled has. raw is the JSON it came as, written
// back as it was unless dirty.
type webConfig struct {
	raw      json.RawMessage
	dirty    bool
	rest     map[string]json.RawMessage
	handlers map[string]json.RawMessage
}

func parseServe(raw []byte, withForeground bool) (*serveDoc, error) {
	d := &serveDoc{
		top: map[string]json.RawMessage{}, tcp: map[string]json.RawMessage{},
		web: map[string]*webConfig{}, funnel: map[string]bool{}, freed: map[string]bool{},
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || isNull(raw) {
		return d, nil
	}
	bad := func(err error) (*serveDoc, error) {
		return nil, fmt.Errorf("reading tailscaled's Serve config: %w", err)
	}
	if err := json.Unmarshal(raw, &d.top); err != nil {
		return bad(err)
	}
	if v, ok := d.top["TCP"]; ok && !isNull(v) {
		if err := json.Unmarshal(v, &d.tcp); err != nil {
			return bad(err)
		}
	}
	if v, ok := d.top["Web"]; ok && !isNull(v) {
		var web map[string]json.RawMessage
		if err := json.Unmarshal(v, &web); err != nil {
			return bad(err)
		}
		for hp, cfg := range web {
			wc := &webConfig{raw: cfg, rest: map[string]json.RawMessage{}, handlers: map[string]json.RawMessage{}}
			if !isNull(cfg) {
				if err := json.Unmarshal(cfg, &wc.rest); err != nil {
					return bad(err)
				}
			}
			if h, ok := wc.rest["Handlers"]; ok {
				delete(wc.rest, "Handlers")
				if !isNull(h) {
					if err := json.Unmarshal(h, &wc.handlers); err != nil {
						return bad(err)
					}
				}
			}
			d.web[hp] = wc
		}
	}
	if v, ok := d.top["AllowFunnel"]; ok && !isNull(v) {
		if err := json.Unmarshal(v, &d.funnel); err != nil {
			return bad(err)
		}
	}
	if v, ok := d.top["Foreground"]; ok && withForeground && !isNull(v) {
		var fg map[string]json.RawMessage
		if err := json.Unmarshal(v, &fg); err != nil {
			return bad(err)
		}
		for _, id := range sortedKeys(fg) {
			sub, err := parseServe(fg[id], false)
			if err != nil {
				return nil, err
			}
			d.foreground = append(d.foreground, sub)
		}
	}
	return d, nil
}

// encode writes the config back: the decoded parts that changed are
// encoded again, the rest is the raw JSON it came with.
func (d *serveDoc) encode() ([]byte, error) {
	if d.tcpDirty {
		if len(d.tcp) == 0 {
			delete(d.top, "TCP")
		} else {
			b, err := marshalRaw(d.tcp)
			if err != nil {
				return nil, err
			}
			d.top["TCP"] = b
		}
	}
	if d.webDirty {
		if len(d.web) == 0 {
			delete(d.top, "Web")
		} else {
			web := map[string]json.RawMessage{}
			for hp, wc := range d.web {
				if !wc.dirty && wc.raw != nil {
					web[hp] = wc.raw
					continue
				}
				h, err := marshalRaw(wc.handlers)
				if err != nil {
					return nil, err
				}
				obj := map[string]json.RawMessage{"Handlers": h}
				for k, v := range wc.rest {
					obj[k] = v
				}
				if web[hp], err = marshalRaw(obj); err != nil {
					return nil, err
				}
			}
			b, err := marshalRaw(web)
			if err != nil {
				return nil, err
			}
			d.top["Web"] = b
		}
	}
	return marshalRaw(d.top)
}

// removeOurs deletes every handler whose Proxy is in ours, except keep,
// and hosts left without handlers. It reports whether it removed any.
func (d *serveDoc) removeOurs(ours map[string]bool, keep *ServeEntry) bool {
	removed := false
	for _, hp := range sortedKeys(d.web) {
		wc := d.web[hp]
		for _, mount := range sortedKeys(wc.handlers) {
			p := proxyOf(wc.handlers[mount])
			if !ours[p] || keep != nil && *keep == (ServeEntry{HostPort: hp, Path: mount, Proxy: p}) {
				continue
			}
			delete(wc.handlers, mount)
			removed, wc.dirty, d.webDirty = true, true, true
			if len(wc.handlers) == 0 && len(wc.rest) == 0 {
				delete(d.web, hp)
				d.freed[portOf(hp)] = true
			}
		}
	}
	return removed
}

// dropUnusedTCP removes the TCP entry of a freed port when no host uses
// the port any more and the entry only serves web handlers.
func (d *serveDoc) dropUnusedTCP() {
	for port := range d.freed {
		if !d.portUsed(port) && (tcpServes(d.tcp[port], true) || tcpServes(d.tcp[port], false)) {
			delete(d.tcp, port)
			d.tcpDirty = true
		}
	}
	d.freed = map[string]bool{}
}

func (d *serveDoc) portUsed(port string) bool {
	for hp := range d.web {
		if portOf(hp) == port {
			return true
		}
	}
	return false
}

func (d *serveDoc) funnelOn(hp string) bool {
	if d.funnel[hp] {
		return true
	}
	for _, fg := range d.foreground {
		if fg.funnel[hp] {
			return true
		}
	}
	return false
}

// conflictAt says why the agent's entry cannot go on hp, or "".
func (d *serveDoc) conflictAt(hp, port string, https bool, ours map[string]bool) string {
	if wc := d.web[hp]; wc != nil {
		for _, mount := range sortedKeys(wc.handlers) {
			if !ours[proxyOf(wc.handlers[mount])] {
				return fmt.Sprintf("Tailscale Serve already has another handler on %s (path %s). "+
					"%s leaves it alone and adds nothing; remove it to serve the panel there.", hp, mount, brand.DisplayName)
			}
		}
	}
	if raw, ok := d.tcp[port]; ok && !tcpServes(raw, https) {
		return fmt.Sprintf("Tailscale Serve already uses port %s for %s. %s leaves it alone and adds nothing.", port, tcpDescribe(raw), brand.DisplayName)
	}
	for _, fg := range d.foreground {
		_, tcp := fg.tcp[port]
		if wc := fg.web[hp]; tcp || wc != nil && len(wc.handlers) > 0 {
			return fmt.Sprintf("A tailscale serve command running in the foreground uses %s. "+
				"%s adds nothing there until it stops.", hp, brand.DisplayName)
		}
	}
	return ""
}

func (d *serveDoc) entryAt(hp, mount string, ours map[string]bool) *ServeEntry {
	if wc := d.web[hp]; wc != nil {
		if p := proxyOf(wc.handlers[mount]); ours[p] {
			return &ServeEntry{HostPort: hp, Path: mount, Proxy: p}
		}
	}
	return nil
}

// tcpHandler is the part of a TCPPortHandler the agent reads.
type tcpHandler struct {
	HTTPS        bool
	HTTP         bool
	TCPForward   string
	TerminateTLS string
}

func decodeTCP(raw json.RawMessage) (tcpHandler, bool) {
	var h tcpHandler
	if len(raw) == 0 || isNull(raw) || json.Unmarshal(raw, &h) != nil {
		return h, false
	}
	return h, true
}

// tcpServes reports whether a TCP port entry serves Web handlers over
// HTTPS (https) or plain HTTP.
func tcpServes(raw json.RawMessage, https bool) bool {
	h, ok := decodeTCP(raw)
	if !ok || h.TCPForward != "" || h.TerminateTLS != "" {
		return false
	}
	if https {
		return h.HTTPS && !h.HTTP
	}
	return h.HTTP && !h.HTTPS
}

func tcpDescribe(raw json.RawMessage) string {
	h, _ := decodeTCP(raw)
	switch {
	case h.TCPForward != "":
		return "a TCP forward to " + h.TCPForward
	case h.HTTPS:
		return "HTTPS"
	case h.HTTP:
		return "plain HTTP"
	}
	return "something else"
}

func webTCP(https bool) json.RawMessage {
	if https {
		return json.RawMessage(`{"HTTPS":true}`)
	}
	return json.RawMessage(`{"HTTP":true}`)
}

func ourHandler(target string) json.RawMessage {
	b, _ := marshalRaw(map[string]string{"Proxy": target})
	return b
}

// proxyOf is a handler's Proxy, "" when it has none or does not decode.
func proxyOf(raw json.RawMessage) string {
	var h struct{ Proxy string }
	if len(raw) == 0 || isNull(raw) || json.Unmarshal(raw, &h) != nil {
		return ""
	}
	return h.Proxy
}

func portOf(hp string) string {
	if i := strings.LastIndexByte(hp, ':'); i >= 0 {
		return hp[i+1:]
	}
	return ""
}

func scheme(https bool) string {
	if https {
		return "https"
	}
	return "http"
}

func isNull(raw []byte) bool { return bytes.Equal(bytes.TrimSpace(raw), []byte("null")) }

func toSet(list []string) map[string]bool {
	set := map[string]bool{}
	for _, s := range list {
		if s != "" {
			set[s] = true
		}
	}
	return set
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// marshalRaw encodes v without escaping <, > and &, so raw values from
// tailscaled come back exactly as they were.
func marshalRaw(v any) (json.RawMessage, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}
