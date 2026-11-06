package localapi

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
	"path/filepath"
	"strconv"
	"time"

	"github.com/seylo-dev/app/go/internal/stub"
)

// Backend is what the agent exposes on the socket.
type Backend interface {
	Status(ctx context.Context) (NodeStatus, error)
	Version() VersionInfo
	PanelStatus(ctx context.Context) (PanelStatus, error)
	StartPanel(ctx context.Context) error
	PanelLogs(ctx context.Context, opts LogsOptions, w io.Writer) error
}

// Serve listens on the unix socket (mode 0600, replacing a stale one) and
// serves b until ctx ends.
func Serve(ctx context.Context, socket string, b Backend, logger *slog.Logger) error {
	if err := os.MkdirAll(filepath.Dir(socket), 0o700); err != nil {
		return fmt.Errorf("creating socket folder: %w", err)
	}
	if err := os.Remove(socket); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("removing stale socket: %w", err)
	}
	ln, err := net.Listen("unix", socket)
	if err != nil {
		return fmt.Errorf("listening on %s: %w", socket, err)
	}
	if err := os.Chmod(socket, 0o600); err != nil {
		ln.Close()
		return fmt.Errorf("chmod %s: %w", socket, err)
	}
	srv := &http.Server{Handler: Handler(b), ReadHeaderTimeout: 10 * time.Second, ErrorLog: slog.NewLogLogger(logger.Handler(), slog.LevelWarn)}
	stop := context.AfterFunc(ctx, func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	})
	defer stop()
	err = srv.Serve(ln)
	_ = os.Remove(socket)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// Handler is the HTTP API over b, mounted on the socket by Serve.
func Handler(b Backend) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/status", func(w http.ResponseWriter, r *http.Request) {
		s, err := b.Status(r.Context())
		respond(w, s, err)
	})
	mux.HandleFunc("GET /v1/version", func(w http.ResponseWriter, r *http.Request) {
		respond(w, b.Version(), nil)
	})
	mux.HandleFunc("GET /v1/panel", func(w http.ResponseWriter, r *http.Request) {
		s, err := b.PanelStatus(r.Context())
		respond(w, s, err)
	})
	mux.HandleFunc("POST /v1/panel/start", func(w http.ResponseWriter, r *http.Request) {
		respond(w, struct{}{}, b.StartPanel(r.Context()))
	})
	mux.HandleFunc("GET /v1/panel/logs", func(w http.ResponseWriter, r *http.Request) {
		tail, _ := strconv.Atoi(r.URL.Query().Get("tail"))
		opts := LogsOptions{Tail: tail, Follow: r.URL.Query().Get("follow") == "true"}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fw := &flushWriter{w: w}
		if err := b.PanelLogs(r.Context(), opts, fw); err != nil && !fw.wrote {
			respond(w, nil, err)
		}
	})
	return mux
}

// apiError is the error body: {"error": {"code", "message"}}.
type apiError struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func respond(w http.ResponseWriter, v any, err error) {
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		var body apiError
		status := http.StatusInternalServerError
		body.Error.Code, body.Error.Message = "INTERNAL", err.Error()
		if errors.Is(err, stub.ErrNotImplemented) {
			status, body.Error.Code = http.StatusNotImplemented, "NOT_IMPLEMENTED"
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
		return
	}
	_ = json.NewEncoder(w).Encode(v)
}

// flushWriter flushes after every write so followed logs arrive live.
type flushWriter struct {
	w     http.ResponseWriter
	wrote bool
}

func (f *flushWriter) Write(p []byte) (int, error) {
	f.wrote = true
	n, err := f.w.Write(p)
	if fl, ok := f.w.(http.Flusher); ok {
		fl.Flush()
	}
	return n, err
}
