package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/state"
)

// What the agent remembers about its panel across restarts and updates,
// in <data dir>/state/panel.json (added in 0.2.15). Only the agent writes
// it; a missing or unreadable file starts empty.
//
//   - nodeName: the node's name in the panel (HelloAccepted.node_name), so
//     `seylo status` names the node as the panel does once it connected.
//   - moveWaits: moves that failed on a certificate the node does not
//     trust or that did not match the pin (inspectedCertificate, move.go),
//     with the address and when it may be tried again. Before, they lived
//     only in memory: every restart (an update included) tried the move
//     once more, dropped the first session the panel accepted and raised
//     PANEL_MOVE_FAILED again. A wait goes once the panel stops naming its
//     address or names another, or the move works.
//   - away: the last connect error since the last accepted session, sent
//     in the next ClientHello (AwayReport) and cleared once a session is
//     accepted.

// panelMemoryFile is the file name under the state dir.
const panelMemoryFile = "panel.json"

// panelMemory is state/panel.json.
type panelMemory struct {
	NodeName  string           `json:"nodeName,omitempty"`
	MoveWaits []storedMoveWait `json:"moveWaits,omitempty"`
	Away      *awayState       `json:"away,omitempty"`
}

// storedMoveWait is one failed move that waits for its retry.
type storedMoveWait struct {
	URL   string    `json:"url"`
	Pin   string    `json:"pin,omitempty"`
	Until time.Time `json:"until"`
}

// awayState is the connect trouble since the last accepted session.
type awayState struct {
	// Since is when the last session ended, or the agent started.
	Since       time.Time `json:"since"`
	LastError   string    `json:"lastError,omitempty"`
	LastErrorAt time.Time `json:"lastErrorAt"`
	Attempts    uint32    `json:"attempts,omitempty"`
}

// moveWait is a failed move in memory: when it may be tried again, and
// whether it is kept in panel.json.
type moveWait struct {
	target panelTarget
	until  time.Time
	kept   bool
}

func panelMemoryPath(layout datadir.Layout) string {
	return filepath.Join(layout.StateDir(), panelMemoryFile)
}

// loadPanelMemory reads panel.json; a missing file is an empty memory and
// an unreadable one is logged by the caller and replaced on the next write.
func loadPanelMemory(path string) (panelMemory, error) {
	var m panelMemory
	if path == "" {
		return m, nil
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return m, nil
	}
	if err != nil {
		return m, fmt.Errorf("reading %s: %w", path, err)
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return panelMemory{}, fmt.Errorf("parsing %s: %w", path, err)
	}
	return m, nil
}

func savePanelMemory(path string, m panelMemory) error {
	if path == "" {
		return nil
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return state.WriteFileAtomic(path, append(b, '\n'), 0o600)
}

// restoreMemory loads panel.json into the connector at start: the stored
// node name, the move waits that have not run out, and the away state (a
// fresh one from now when there is none).
func (c *connector) restoreMemory(now time.Time) {
	m, err := loadPanelMemory(c.memPath)
	if err != nil {
		c.logger.Warn("the agent's panel memory was unreadable; starting without it", "err", err)
	}
	c.memMu.Lock()
	c.nodeName = m.NodeName
	c.memMu.Unlock()
	for _, w := range m.MoveWaits {
		if !now.Before(w.Until) {
			continue
		}
		t := panelTarget{url: w.URL, pin: w.Pin}
		if c.moveRetry == nil {
			c.moveRetry = map[string]moveWait{}
		}
		c.moveRetry[moveKey(t)] = moveWait{target: t, until: w.Until, kept: true}
	}
	c.away = awayState{Since: now}
	if m.Away != nil {
		c.away = *m.Away
	}
}

// saveMemory writes panel.json from the connector's state. Run goroutine
// only (it reads moveRetry and away); a failed write is logged.
func (c *connector) saveMemory() {
	m := panelMemory{}
	c.memMu.Lock()
	m.NodeName = c.nodeName
	c.memMu.Unlock()
	now := time.Now()
	for _, w := range c.moveRetry {
		if w.kept && now.Before(w.until) {
			m.MoveWaits = append(m.MoveWaits, storedMoveWait{URL: w.target.url, Pin: w.target.pin, Until: w.until})
		}
	}
	if c.away.LastError != "" {
		away := c.away
		m.Away = &away
	}
	if err := savePanelMemory(c.memPath, m); err != nil {
		c.logger.Error("could not write the agent's panel memory", "path", c.memPath, "err", err)
	}
}

// panelNodeName is the node's name in the panel, "" before the first
// connect to a panel that sends it.
func (c *connector) panelNodeName() string {
	c.memMu.Lock()
	defer c.memMu.Unlock()
	return c.nodeName
}

// connectFailed records a failed connect for the next hello's AwayReport.
// panel.json is written when the error changes and at most once a minute
// otherwise, not on every retry.
func (c *connector) connectFailed(err error) {
	if err == nil {
		return
	}
	msg := conn.PrintableLine(err.Error())
	if r := []rune(msg); len(r) > awayErrorMax {
		msg = string(r[:awayErrorMax-3]) + "..."
	}
	now := time.Now()
	if c.away.Since.IsZero() {
		c.away.Since = now
	}
	changed := c.away.LastError != msg
	c.away.LastError, c.away.LastErrorAt = msg, now
	c.away.Attempts++
	if changed || now.Sub(c.awaySaved) >= time.Minute {
		c.awaySaved = now
		c.saveMemory()
	}
}

// awayErrorMax caps AwayReport.last_error, in runes.
const awayErrorMax = 500

// sessionEnded starts a new away period: the session that was served ended.
func (c *connector) sessionEnded() {
	c.away = awayState{Since: time.Now()}
}

// awayReport is ClientHello.away: nil while no connect failed since the
// last accepted session.
func (c *connector) awayReport() *agentv1.AwayReport {
	if c.away.LastError == "" {
		return nil
	}
	r := &agentv1.AwayReport{LastError: c.away.LastError, FailedAttempts: c.away.Attempts}
	if !c.away.Since.IsZero() {
		r.Since = timestamppb.New(c.away.Since)
	}
	if !c.away.LastErrorAt.IsZero() {
		r.LastErrorAt = timestamppb.New(c.away.LastErrorAt)
	}
	return r
}

// accepted runs for every session the panel accepted, before anything
// else uses it: the away report went out with the hello, the panel's name
// for the node is kept, a stay request the panel answered is done, and
// failed moves to addresses the panel no longer names are forgotten.
func (c *connector) accepted(target panelTarget, acc *agentv1.HelloAccepted) {
	save := false
	if c.away.LastError != "" {
		save = true
	}
	c.away = awayState{}
	if name := conn.PrintableLine(acc.GetNodeName()); name != "" {
		c.memMu.Lock()
		if c.nodeName != name {
			c.nodeName, save = name, true
		}
		c.memMu.Unlock()
	}
	if c.forgetUnnamedMoves(target, acc) {
		save = true
	}
	if save {
		c.saveMemory()
	}
	if acc.GetPanelAddress() != agentv1.PanelAddressChoice_PANEL_ADDRESS_CHOICE_UNSPECIFIED {
		c.stayAnswered(acc.GetPanelAddress())
	}
}

// forgetUnnamedMoves drops the waits of failed moves to addresses the
// panel does not name now: every one when HelloAccepted names none, the
// others when it names one. Only an authenticated session counts (a plain
// HTTP one could have been written by anyone on the path, and never moves
// the node anyway). Reports whether a kept wait went.
func (c *connector) forgetUnnamedMoves(current panelTarget, acc *agentv1.HelloAccepted) bool {
	if len(c.moveRetry) == 0 || !tlsURL(current.url) || ownNodePanel(current.url) {
		return false
	}
	keep := ""
	if raw := acc.GetPanelUrl(); raw != "" {
		named, err := parseMoveTarget(raw, acc.GetPanelPin())
		if err != nil {
			return false
		}
		keep = moveKey(named)
	}
	dropped := false
	for key, w := range c.moveRetry {
		if key == keep {
			continue
		}
		delete(c.moveRetry, key)
		dropped = dropped || w.kept
	}
	return dropped
}

// stayAnswered ends a pending stay request (config.yml stay_on_address)
// once the panel answered it with the node's Panel address.
func (c *connector) stayAnswered(choice agentv1.PanelAddressChoice) {
	c.cfgMu.Lock()
	defer c.cfgMu.Unlock()
	if !c.cfg.StayOnAddress {
		return
	}
	c.cfg.StayOnAddress = false
	c.logger.Info("the panel recorded this node's Panel address", "panel_address", choice.String())
	c.saveConfigLocked()
}
