package dockerapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func frame(stream byte, payload string) []byte {
	var h [8]byte
	h[0] = stream
	binary.BigEndian.PutUint32(h[4:], uint32(len(payload)))
	return append(h[:], payload...)
}

func TestDemux(t *testing.T) {
	var in bytes.Buffer
	in.Write(frame(StreamStdout, "out1 "))
	in.Write(frame(StreamStderr, "err1"))
	in.Write(frame(StreamStdin, "ignored"))
	in.Write(frame(StreamStdout, "out2"))
	var out, errs bytes.Buffer
	if err := Demux(&in, &out, &errs); err != nil {
		t.Fatal(err)
	}
	if out.String() != "out1 out2" || errs.String() != "err1" {
		t.Fatalf("out %q err %q", out.String(), errs.String())
	}
	if err := Demux(bytes.NewReader(frame(StreamStdout, "abc")[:9]), io.Discard, io.Discard); err == nil {
		t.Fatal("truncated frame accepted")
	}
	huge := frame(StreamStdout, "")
	binary.BigEndian.PutUint32(huge[4:], maxFrame+1)
	if err := Demux(bytes.NewReader(huge), io.Discard, io.Discard); err == nil {
		t.Fatal("oversized frame accepted")
	}
}

// fakeDaemon serves one hijack: it answers 101 and then echoes in upper
// case until the client half-closes, then writes "bye".
func fakeDaemon(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "dapi")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "d.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				br := bufio.NewReader(conn)
				req, err := http.ReadRequest(br)
				if err != nil {
					return
				}
				if req.URL.Path == "/containers/missing/attach" {
					_, _ = io.WriteString(conn, "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 27\r\n\r\n{\"message\":\"no such thing\"}")
					return
				}
				if req.Header.Get("Upgrade") != "tcp" {
					return
				}
				_, _ = io.WriteString(conn, "HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
				data, _ := io.ReadAll(br)
				_, _ = conn.Write([]byte(strings.ToUpper(string(data)) + "bye"))
			}()
		}
	}()
	return sock
}

func TestHijack(t *testing.T) {
	c := New(fakeDaemon(t))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := c.Attach(ctx, "abc")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.Write([]byte("hello ")); err != nil {
		t.Fatal(err)
	}
	if err := s.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(s)
	if string(got) != "HELLO bye" {
		t.Fatalf("got %q", got)
	}
	_, err = c.Attach(ctx, "missing")
	if !IsNotFound(err) || !strings.Contains(err.Error(), "no such thing") {
		t.Fatalf("missing = %v", err)
	}
}
