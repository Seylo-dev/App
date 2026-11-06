package conn

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// echoPanel accepts the agent subprotocol and echoes every message back.
func echoPanel(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{Subprotocol}})
		if err != nil {
			return
		}
		defer c.CloseNow()
		for {
			typ, b, err := c.Read(r.Context())
			if err != nil {
				return
			}
			if err := c.Write(r.Context(), typ, b); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func wsURL(srv *httptest.Server) string {
	return "wss" + strings.TrimPrefix(srv.URL, "https")
}

func TestDialWithPinAndExchangeFrames(t *testing.T) {
	srv := echoPanel(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ws, err := Dial(ctx, DialOptions{URL: wsURL(srv), PinSHA256: SPKIFingerprint(srv.Certificate())})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close("test done")

	w := NewWriter(ws)
	defer w.Close(nil)
	want := Frame{Kind: KindCall, Stream: 1, Payload: []byte("ping")}
	if err := w.WriteControl(ctx, want); err != nil {
		t.Fatal(err)
	}
	got, err := ws.ReadFrame(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != want.Kind || got.Stream != want.Stream || !bytes.Equal(got.Payload, want.Payload) {
		t.Fatalf("echo = %+v, want %+v", got, want)
	}
}

func TestDialRejectsWrongPin(t *testing.T) {
	srv := echoPanel(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wrong := bytes.Repeat([]byte{0x42}, 32)
	_, err := Dial(ctx, DialOptions{URL: wsURL(srv), PinSHA256: wrong})
	if !errors.Is(err, ErrPinMismatch) {
		t.Fatalf("err = %v, want ErrPinMismatch", err)
	}
}

func TestDialWithoutPinVerifiesCertificate(t *testing.T) {
	srv := echoPanel(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// httptest's certificate is self-signed, so CA verification must fail.
	if _, err := Dial(ctx, DialOptions{URL: wsURL(srv)}); err == nil {
		t.Fatal("dial without a pin accepted a self-signed certificate")
	}
}

func TestDialRequiresSubprotocol(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil) // ignores the subprotocol
		if err == nil {
			c.CloseNow()
		}
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := Dial(ctx, DialOptions{URL: wsURL(srv), PinSHA256: SPKIFingerprint(srv.Certificate())})
	if err == nil || !strings.Contains(err.Error(), "subprotocol") {
		t.Fatalf("err = %v, want a subprotocol error", err)
	}
}

func TestReadFrameRejectsText(t *testing.T) {
	srv := echoPanel(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ws, err := Dial(ctx, DialOptions{URL: wsURL(srv), PinSHA256: SPKIFingerprint(srv.Certificate())})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close("test done")
	if err := ws.c.Write(ctx, websocket.MessageText, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.ReadFrame(ctx); !errors.Is(err, ErrNotBinary) {
		t.Fatalf("err = %v, want ErrNotBinary", err)
	}
}
