package hostshell

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Defaults for Options.
const (
	DefaultMax  = 2
	DefaultIdle = 15 * time.Minute
)

var (
	// ErrDisabled means host shells are off for this node (the panel
	// setting, or config.yml's no_host_shell); the error's text says which.
	ErrDisabled = errors.New("host shells are turned off on this node")
	// ErrBusy means Max shells are open already.
	ErrBusy = errors.New("too many host shells are open on this node")
	// ErrUnsupported means this OS has no host shells (Linux only).
	ErrUnsupported = errors.New("host shells need a Linux node")
)

// Options configure a Manager.
type Options struct {
	// Allowed is asked before every shell; a non-nil error (wrapping
	// ErrDisabled) refuses it. Required.
	Allowed func() error
	// Max open shells at a time; 0 means DefaultMax.
	Max int
	// Idle without input or output after which a shell is hung up; 0
	// means DefaultIdle.
	Idle time.Duration
	// Passwd is the passwd file the login shell and home come from;
	// empty means /etc/passwd.
	Passwd string
	Logger *slog.Logger
}

// Manager opens and tracks host shells.
type Manager struct {
	opts Options
	mu   sync.Mutex
	open map[*Session]struct{}
	// starting counts shells being started, so two opens never pass Max.
	starting int
}

// New returns a Manager.
func New(opts Options) *Manager {
	if opts.Max <= 0 {
		opts.Max = DefaultMax
	}
	if opts.Idle <= 0 {
		opts.Idle = DefaultIdle
	}
	if opts.Passwd == "" {
		opts.Passwd = "/etc/passwd"
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	return &Manager{opts: opts, open: map[*Session]struct{}{}}
}

// Idle is how long a shell may be quiet before it is hung up.
func (m *Manager) Idle() time.Duration { return m.opts.Idle }

// Open starts a login shell. The session ends when its shell exits, when
// Close is called, when it idles past Idle or when CloseAll runs.
func (m *Manager) Open(ctx context.Context, open *agentv1.HostShellOpen) (*Session, error) {
	if err := m.opts.Allowed(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	if len(m.open)+m.starting >= m.opts.Max {
		m.mu.Unlock()
		return nil, fmt.Errorf("%w (at most %d)", ErrBusy, m.opts.Max)
	}
	m.starting++
	m.mu.Unlock()

	s := &Session{manager: m, done: make(chan struct{}), openedBy: open.GetOpenedBy(), sessionID: open.GetSessionId()}
	login, err := loginFor(m.opts.Passwd, os.Getuid())
	if err == nil {
		err = s.start(ctx, login, open.GetSize())
	}
	m.mu.Lock()
	m.starting--
	if err == nil {
		m.open[s] = struct{}{}
	}
	m.mu.Unlock()
	if err != nil {
		return nil, err
	}
	// The setting may have turned off while the shell started: CloseAll did
	// not see this one yet.
	if err := m.opts.Allowed(); err != nil {
		s.closeWith(ReasonDisabled)
		return nil, err
	}
	m.opts.Logger.Info("host shell opened", "session_id", s.sessionID, "opened_by", s.openedBy, "user", login.user, "shell", login.shell)
	go s.watchIdle(m.opts.Idle)
	go func() {
		<-s.done
		m.forget(s)
		m.opts.Logger.Info("host shell closed", "session_id", s.sessionID, "opened_by", s.openedBy,
			"seconds", int(time.Since(s.started).Seconds()), "reason", s.endReason())
	}()
	return s, nil
}

// Count is the number of open shells.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.open)
}

// CloseAll hangs up every open shell, for example when the setting turned
// off.
func (m *Manager) CloseAll(reason string) {
	m.mu.Lock()
	all := make([]*Session, 0, len(m.open))
	for s := range m.open {
		all = append(all, s)
	}
	m.mu.Unlock()
	for _, s := range all {
		s.closeWith(reason)
	}
}

func (m *Manager) forget(s *Session) {
	m.mu.Lock()
	delete(m.open, s)
	m.mu.Unlock()
}
