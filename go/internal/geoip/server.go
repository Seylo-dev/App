package geoip

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// DefaultPort is the lookup server's port on the edge network's gateway,
// next to the edge listener's 5756 and the LB entry point's 5757.
const DefaultPort = 5758

// ServerProtocol is what the lookup server answers and how. The agent
// restarts a running server that reports an older one (an agent update
// leaves the server it started running the binary it started with).
const ServerProtocol = 1

// HealthPath answers the server's state as JSON (Health). Every other path
// is a lookup: forwardAuth asks the address it is given, whatever the
// visitor's path.
const HealthPath = "/health"

// ReloadInterval is how often the server looks for a new database file.
const ReloadInterval = 30 * time.Second

// Health is what HealthPath answers.
type Health struct {
	Protocol int    `json:"protocol"`
	Version  string `json:"version,omitempty"`
	// Database is nil while none is loaded (every lookup answers Unknown).
	Database *DBInfo `json:"database,omitempty"`
	// Error is why the newest file did not load, if it did not.
	Error string `json:"error,omitempty"`
}

// Server answers forwardAuth requests with the visitor's country.
type Server struct {
	// Path is the database file (Fetcher.Path).
	Path string
	// Version is the binary's release, for Health.
	Version string
	Logger  *slog.Logger

	db atomic.Pointer[DB]

	mu      sync.Mutex
	loaded  os.FileInfo
	loadErr string
}

func (s *Server) log() *slog.Logger {
	if s.Logger == nil {
		return slog.New(slog.DiscardHandler)
	}
	return s.Logger
}

// Reload loads Path when it is not the file loaded last, keeping the
// database it has when the new one does not open. A missing file leaves
// the server without one (it answers Unknown) and is no error.
func (s *Server) Reload() (changed bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := os.Stat(s.Path)
	if errors.Is(err, os.ErrNotExist) {
		if s.loaded != nil {
			s.log().Warn("the country database is gone; keeping the one in memory", "path", s.Path)
		}
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if s.loaded != nil && os.SameFile(s.loaded, info) && s.loaded.ModTime().Equal(info.ModTime()) && s.loaded.Size() == info.Size() {
		return false, nil
	}
	db, err := readDB(s.Path)
	if err != nil {
		// Remember the file so a broken one is not read again every pass.
		s.loaded, s.loadErr = info, err.Error()
		return false, err
	}
	s.db.Store(db)
	s.loaded, s.loadErr = info, ""
	i := db.Info()
	s.log().Info("country database loaded", "type", i.Type, "built", i.Built.Format(time.DateOnly), "bytes", i.Size)
	return true, nil
}

// readDB reads and opens a database file.
func readDB(path string) (*DB, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, MaxDatabaseSize+1))
	if err != nil {
		return nil, err
	}
	return Open(data)
}

// Watch reloads the database every interval until ctx ends.
func (s *Server) Watch(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if _, err := s.Reload(); err != nil {
				s.log().Error("loading the country database", "path", s.Path, "err", err)
			}
		}
	}
}

// Health is the server's state.
func (s *Server) Health() Health {
	h := Health{Protocol: ServerProtocol, Version: s.Version}
	if db := s.db.Load(); db != nil {
		i := db.Info()
		h.Database = &i
	}
	s.mu.Lock()
	h.Error = s.loadErr
	s.mu.Unlock()
	return h
}

// Country is the country of the request a forwardAuth request is about.
func (s *Server) Country(h http.Header) string {
	ip, ok := ClientIP(h)
	if !ok {
		return Unknown
	}
	return s.db.Load().Country(ip)
}

// ServeHTTP answers a lookup, always 200 with an empty body: forwardAuth
// hands any other status and its body to the visitor in place of the app.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path == HealthPath {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.Health())
		return
	}
	w.Header().Set(Header, s.Country(r.Header))
	w.Header().Set("Content-Length", "0")
	w.WriteHeader(http.StatusOK)
}

// Serve loads the database, then answers on l until ctx ends, and shuts
// down gracefully: requests in flight finish, and with a socket from
// systemd new connections wait in the socket's queue for the next start.
func (s *Server) Serve(ctx context.Context, l net.Listener) error {
	if _, err := s.Reload(); err != nil {
		s.log().Error("loading the country database; answering "+Unknown+" until one loads", "path", s.Path, "err", err)
	}
	go s.Watch(ctx, ReloadInterval)
	srv := &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
		// Longer than the idle timeout of Traefik's client (Go's default
		// transport keeps idle connections 90 s): a connection the server
		// closes while the client reuses it would fail that request.
		IdleTimeout:    5 * time.Minute,
		MaxHeaderBytes: 64 << 10,
		ErrorLog:       slog.NewLogLogger(s.log().Handler(), slog.LevelDebug),
	}
	done := make(chan error, 1)
	go func() { done <- srv.Serve(l) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := srv.Shutdown(shutdown)
	<-done
	return err
}

// Listener is the socket systemd passed (socket activation: LISTEN_PID is
// this process and LISTEN_FDS 1), else a new one on addr. An empty addr
// without a socket from systemd is an error.
func Listener(addr string) (net.Listener, error) { return listener(addr, listenFDsStart) }

// listenFDsStart is the first descriptor systemd passes (SD_LISTEN_FDS_START).
const listenFDsStart = 3

func listener(addr string, fd uintptr) (net.Listener, error) {
	if pid, err := strconv.Atoi(os.Getenv("LISTEN_PID")); err == nil && pid == os.Getpid() {
		n, _ := strconv.Atoi(os.Getenv("LISTEN_FDS"))
		os.Unsetenv("LISTEN_PID")
		os.Unsetenv("LISTEN_FDS")
		os.Unsetenv("LISTEN_FDNAMES")
		if n != 1 {
			return nil, fmt.Errorf("systemd passed %d sockets, want 1", n)
		}
		f := os.NewFile(fd, "geoip.socket")
		l, err := net.FileListener(f)
		_ = f.Close()
		if err != nil {
			return nil, fmt.Errorf("the socket from systemd: %w", err)
		}
		return l, nil
	}
	if addr == "" {
		return nil, errors.New("no socket from systemd and no --listen address")
	}
	return net.Listen("tcp", addr)
}
