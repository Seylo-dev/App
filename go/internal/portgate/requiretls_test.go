package portgate

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dbengine"
)

// pgMessage is a startup-phase message: int32 length, int32 code, body.
func pgMessage(code uint32, body []byte) []byte {
	out := make([]byte, 8, 8+len(body))
	binary.BigEndian.PutUint32(out, uint32(8+len(body)))
	binary.BigEndian.PutUint32(out[4:], code)
	return append(out, body...)
}

var (
	pgSSLRequest    = pgMessage(pgSSLRequestCode, nil)
	pgGSSENCRequest = pgMessage(pgGSSENCRequestCode, nil)
	pgCancelRequest = pgMessage(pgCancelRequestCode, []byte{0, 0, 0, 42, 1, 2, 3, 4})
	// A protocol 3.0 StartupMessage with user and database, as psql
	// sslmode=disable sends it.
	pgStartup = pgMessage(196608, []byte("user\x00app\x00database\x00app\x00\x00"))
)

// readPGError reads one ErrorResponse and returns its fields by code.
func readPGError(t *testing.T, c net.Conn) map[byte]string {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	head := make([]byte, 5)
	if _, err := io.ReadFull(c, head); err != nil {
		t.Fatalf("no error response: %v", err)
	}
	if head[0] != 'E' {
		t.Fatalf("message type %q, want E", head[0])
	}
	body := make([]byte, binary.BigEndian.Uint32(head[1:])-4)
	if _, err := io.ReadFull(c, body); err != nil {
		t.Fatal(err)
	}
	fields := map[byte]string{}
	for len(body) > 1 {
		end := bytes.IndexByte(body, 0)
		fields[body[0]] = string(body[1:end])
		body = body[end+1:]
	}
	if len(body) != 1 || body[0] != 0 {
		t.Fatalf("error response not terminated: %q", body)
	}
	return fields
}

func wantPGRefusal(t *testing.T, c net.Conn) {
	t.Helper()
	f := readPGError(t, c)
	if f['S'] != "FATAL" || f['V'] != "FATAL" || f['C'] != "28000" || f['M'] != postgresRefusal {
		t.Fatalf("error fields = %q", f)
	}
}

type startResult struct {
	first      []byte
	sslRequest bool
	err        error
}

// startPostgres runs postgresStart on the gate's end of an in-memory
// connection; the test plays the client on the other end.
func startPostgres(t *testing.T, wait time.Duration) (net.Conn, net.Conn, <-chan startResult) {
	t.Helper()
	gate, client := net.Pipe()
	t.Cleanup(func() { _ = gate.Close(); _ = client.Close() })
	done := make(chan startResult, 1)
	go func() {
		first, ssl, err := postgresStart(gate, wait)
		done <- startResult{first, ssl, err}
	}()
	return gate, client, done
}

func send(t *testing.T, c net.Conn, b []byte) {
	t.Helper()
	_ = c.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if _, err := c.Write(b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func result(t *testing.T, done <-chan startResult) startResult {
	t.Helper()
	select {
	case r := <-done:
		return r
	case <-time.After(3 * time.Second):
		t.Fatal("the check never returned")
		return startResult{}
	}
}

func TestPostgresStartPassesTLSRequests(t *testing.T) {
	t.Run("SSLRequest", func(t *testing.T) {
		_, client, done := startPostgres(t, time.Second)
		send(t, client, pgSSLRequest)
		r := result(t, done)
		if r.err != nil || !r.sslRequest || !bytes.Equal(r.first, pgSSLRequest) {
			t.Fatalf("got %+v", r)
		}
	})
	t.Run("direct TLS (sslnegotiation=direct)", func(t *testing.T) {
		gate, client, done := startPostgres(t, time.Second)
		hello := append([]byte{0x16, 0x03, 0x01, 0x00, 0x10}, bytes.Repeat([]byte{1}, 16)...)
		go func() { _, _ = client.Write(hello) }()
		r := result(t, done)
		if r.err != nil || r.sslRequest || !bytes.Equal(r.first, hello[:8]) {
			t.Fatalf("got %+v", r)
		}
		// Only the 8 bytes it checked were read: the rest is the relay's.
		rest := make([]byte, len(hello)-8)
		_ = gate.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := io.ReadFull(gate, rest); err != nil || !bytes.Equal(rest, hello[8:]) {
			t.Fatalf("rest = %v, %v", rest, err)
		}
	})
	t.Run("CancelRequest", func(t *testing.T) {
		gate, client, done := startPostgres(t, time.Second)
		go func() { _, _ = client.Write(pgCancelRequest) }()
		r := result(t, done)
		if r.err != nil || r.sslRequest || !bytes.Equal(r.first, pgCancelRequest[:8]) {
			t.Fatalf("got %+v", r)
		}
		rest := make([]byte, 8)
		_ = gate.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := io.ReadFull(gate, rest); err != nil || !bytes.Equal(rest, pgCancelRequest[8:]) {
			t.Fatalf("rest = %v, %v", rest, err)
		}
	})
	t.Run("GSSENCRequest, then SSLRequest", func(t *testing.T) {
		_, client, done := startPostgres(t, time.Second)
		send(t, client, pgGSSENCRequest)
		answer := make([]byte, 1)
		_ = client.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := io.ReadFull(client, answer); err != nil || answer[0] != 'N' {
			t.Fatalf("answer to GSSENCRequest = %q, %v", answer, err)
		}
		send(t, client, pgSSLRequest)
		// The database sees the SSLRequest only: the gate answered the GSSENCRequest.
		if r := result(t, done); r.err != nil || !r.sslRequest || !bytes.Equal(r.first, pgSSLRequest) {
			t.Fatalf("got %+v", r)
		}
	})
}

func TestPostgresStartRefusesPlainLogins(t *testing.T) {
	t.Run("StartupMessage", func(t *testing.T) {
		_, client, done := startPostgres(t, time.Second)
		// The whole message is read before the error, so the client is not reset before it reads it.
		send(t, client, pgStartup)
		wantPGRefusal(t, client)
		if r := result(t, done); !errors.Is(r.err, errPlainClient) || r.first != nil {
			t.Fatalf("got %+v", r)
		}
	})
	t.Run("GSSENCRequest, then StartupMessage", func(t *testing.T) {
		_, client, done := startPostgres(t, time.Second)
		send(t, client, pgGSSENCRequest)
		answer := make([]byte, 1)
		_ = client.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := io.ReadFull(client, answer); err != nil || answer[0] != 'N' {
			t.Fatalf("answer = %q, %v", answer, err)
		}
		send(t, client, pgStartup)
		wantPGRefusal(t, client)
		if r := result(t, done); !errors.Is(r.err, errPlainClient) {
			t.Fatalf("got %+v", r)
		}
	})
	for name, second := range map[string][]byte{"GSSENCRequest twice": pgGSSENCRequest, "CancelRequest after GSSENCRequest": pgCancelRequest} {
		t.Run(name, func(t *testing.T) {
			_, client, done := startPostgres(t, time.Second)
			send(t, client, pgGSSENCRequest)
			_ = client.SetReadDeadline(time.Now().Add(time.Second))
			if _, err := io.ReadFull(client, make([]byte, 1)); err != nil {
				t.Fatal(err)
			}
			send(t, client, second)
			wantPGRefusal(t, client)
			if r := result(t, done); !errors.Is(r.err, errPlainClient) {
				t.Fatalf("got %+v", r)
			}
		})
	}
	t.Run("a length past the startup limit is not read", func(t *testing.T) {
		_, client, done := startPostgres(t, time.Second)
		huge := pgMessage(196608, nil)
		binary.BigEndian.PutUint32(huge, 1<<30)
		send(t, client, huge)
		wantPGRefusal(t, client)
		if r := result(t, done); !errors.Is(r.err, errPlainClient) {
			t.Fatalf("got %+v", r)
		}
	})
	for name, sent := range map[string][]byte{"nothing": nil, "half a message": pgSSLRequest[:4]} {
		t.Run("waits a bounded time for "+name, func(t *testing.T) {
			_, client, done := startPostgres(t, 50*time.Millisecond)
			if sent != nil {
				send(t, client, sent)
			}
			var ne net.Error
			if r := result(t, done); !errors.As(r.err, &ne) || !ne.Timeout() {
				t.Fatalf("got %+v, want a timeout", r)
			}
		})
	}
}

func TestPostgresAnswer(t *testing.T) {
	run := func(t *testing.T, answer byte) (net.Conn, <-chan error) {
		gate, client := net.Pipe()
		db, dbGate := net.Pipe()
		t.Cleanup(func() { _ = gate.Close(); _ = client.Close(); _ = db.Close(); _ = dbGate.Close() })
		done := make(chan error, 1)
		go func() { done <- postgresAnswer(gate, dbGate, time.Second) }()
		send(t, db, []byte{answer})
		got := make([]byte, 1)
		_ = client.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := io.ReadFull(client, got); err != nil || got[0] != answer {
			t.Fatalf("client got %q, %v", got, err)
		}
		return client, done
	}
	t.Run("S goes on to TLS", func(t *testing.T) {
		_, done := run(t, 'S')
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	})
	t.Run("N refuses the plain login that follows", func(t *testing.T) {
		client, done := run(t, 'N')
		send(t, client, pgStartup)
		wantPGRefusal(t, client)
		if err := <-done; !errors.Is(err, errPlainClient) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("anything else ends it", func(t *testing.T) {
		_, done := run(t, 'E')
		if err := <-done; err == nil {
			t.Fatal("no error")
		}
	})
}

// mysqlPacket is a packet with its 4-byte header.
func mysqlPacket(seq byte, payload []byte) []byte {
	n := len(payload)
	return append([]byte{byte(n), byte(n >> 8), byte(n >> 16), seq}, payload...)
}

// mysqlResponse is a handshake response (or SSL request) whose capability
// flags are flags, padded like a real one.
func mysqlResponse(flags uint32, rest string) []byte {
	payload := binary.LittleEndian.AppendUint32(nil, flags)
	payload = binary.LittleEndian.AppendUint32(payload, 1<<24)
	payload = append(payload, 255)
	payload = append(payload, make([]byte, 23)...)
	return mysqlPacket(1, append(payload, rest...))
}

var mysqlGreeting = mysqlPacket(0, append([]byte{10}, "8.4.7\x00greeting-scramble-and-flags\x00caching_sha2_password\x00"...))

type mysqlSide struct {
	client, db net.Conn
	done       <-chan startResult
}

// startMySQL runs mysqlStart between an in-memory client and database; the
// test plays both.
func startMySQL(t *testing.T, wait time.Duration) mysqlSide {
	t.Helper()
	gate, client := net.Pipe()
	db, dbGate := net.Pipe()
	t.Cleanup(func() { _ = gate.Close(); _ = client.Close(); _ = db.Close(); _ = dbGate.Close() })
	done := make(chan startResult, 1)
	go func() {
		first, err := mysqlStart(gate, dbGate, wait)
		done <- startResult{first: first, err: err}
	}()
	return mysqlSide{client, db, done}
}

// greet sends the server's first packet and checks the client gets it unchanged.
func (s mysqlSide) greet(t *testing.T, packet []byte) {
	t.Helper()
	go func() { _, _ = s.db.Write(packet) }()
	got := make([]byte, len(packet))
	_ = s.client.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := io.ReadFull(s.client, got); err != nil || !bytes.Equal(got, packet) {
		t.Fatalf("client got %q, %v", got, err)
	}
}

func TestMySQLStartPassesSSLRequests(t *testing.T) {
	s := startMySQL(t, time.Second)
	s.greet(t, mysqlGreeting)
	// CLIENT_SSL with the usual 4.1 flags, as mysql --ssl-mode=REQUIRED sends it.
	request := mysqlResponse(0x0000_0200|0x0000_8000|mysqlClientSSL|0x000f_0000, "")
	go func() { _, _ = s.client.Write(request) }()
	r := result(t, s.done)
	if r.err != nil || !bytes.Equal(r.first, request[:6]) {
		t.Fatalf("got %+v", r)
	}
}

func TestMySQLStartRefusesPlainLogins(t *testing.T) {
	s := startMySQL(t, time.Second)
	s.greet(t, mysqlGreeting)
	// --ssl-mode=DISABLED: the full handshake response, user and auth data included, without CLIENT_SSL.
	plain := mysqlResponse(0x0000_0200|0x0000_8000|0x000f_0000, "root\x00\x20"+strings.Repeat("a", 32)+"app\x00")
	send(t, s.client, plain)
	_ = s.client.SetReadDeadline(time.Now().Add(time.Second))
	head := make([]byte, 4)
	if _, err := io.ReadFull(s.client, head); err != nil {
		t.Fatal(err)
	}
	if head[3] != 2 {
		t.Fatalf("sequence id %d, want the client's + 1", head[3])
	}
	payload := make([]byte, mysqlLength(head))
	if _, err := io.ReadFull(s.client, payload); err != nil {
		t.Fatal(err)
	}
	if payload[0] != 0xFF || binary.LittleEndian.Uint16(payload[1:3]) != 3159 || string(payload[3:9]) != "#HY000" ||
		string(payload[9:]) != mysqlRefusal {
		t.Fatalf("ERR packet = %q", payload)
	}
	if r := result(t, s.done); !errors.Is(r.err, errPlainClient) || r.first != nil {
		t.Fatalf("got %+v", r)
	}
}

func TestMySQLStartEdges(t *testing.T) {
	t.Run("a packet too short for flags is refused", func(t *testing.T) {
		s := startMySQL(t, time.Second)
		s.greet(t, mysqlGreeting)
		send(t, s.client, mysqlPacket(1, []byte{0x08}))
		_ = s.client.SetReadDeadline(time.Now().Add(time.Second))
		want := mysqlError(2, mysqlInsecureTransport, "HY000", mysqlRefusal)
		got := make([]byte, len(want))
		if _, err := io.ReadFull(s.client, got); err != nil || !bytes.Equal(got, want) {
			t.Fatalf("got %q, %v", got, err)
		}
		if r := result(t, s.done); !errors.Is(r.err, errPlainClient) {
			t.Fatalf("got %+v", r)
		}
	})
	t.Run("the server's error goes to the client as it is", func(t *testing.T) {
		s := startMySQL(t, time.Second)
		tooMany := mysqlError(0, 1040, "08004", "Too many connections")
		s.greet(t, tooMany)
		_ = s.client.Close()
		if r := result(t, s.done); r.err == nil {
			t.Fatalf("got %+v", r)
		}
	})
	t.Run("waits a bounded time for the client", func(t *testing.T) {
		s := startMySQL(t, 50*time.Millisecond)
		s.greet(t, mysqlGreeting)
		var ne net.Error
		if r := result(t, s.done); !errors.As(r.err, &ne) || !ne.Timeout() {
			t.Fatalf("got %+v, want a timeout", r)
		}
	})
	t.Run("waits a bounded time for the greeting", func(t *testing.T) {
		s := startMySQL(t, 50*time.Millisecond)
		var ne net.Error
		if r := result(t, s.done); !errors.As(r.err, &ne) || !ne.Timeout() {
			t.Fatalf("got %+v, want a timeout", r)
		}
	})
}

// recorder stands in for a database container: it keeps what each
// connection sent and answers with answer once it got want bytes (or
// sends greeting first).
type recorder struct {
	addr  string
	conns chan []byte
}

func recordingServer(t *testing.T, greeting, answer []byte, want int) *recorder {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	r := &recorder{addr: ln.Addr().String(), conns: make(chan []byte, 8)}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_ = c.SetDeadline(time.Now().Add(3 * time.Second))
				if greeting != nil {
					_, _ = c.Write(greeting)
				}
				got := make([]byte, want)
				n, _ := io.ReadFull(c, got)
				if n == want && answer != nil {
					_, _ = c.Write(answer)
				}
				r.conns <- got[:n]
			}()
		}
	}()
	return r
}

func dialGate(t *testing.T, port uint32) net.Conn {
	t.Helper()
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(int(port)), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	return c
}

// The checks run on the exposed ports of real listeners: what passes
// reaches the database unchanged, a plain Postgres login never reaches it.
func TestRequireTLSListeners(t *testing.T) {
	t.Run("postgres", func(t *testing.T) {
		db := recordingServer(t, nil, []byte{'S'}, len(pgSSLRequest))
		m := newManager(t, db.addr)
		ports, err := m.Sync(context.Background(), "pg", []Listener{{ID: "database", ContainerPort: 5432, RequireTLS: TLSCheckPostgres}})
		if err != nil {
			t.Fatal(err)
		}
		plain := dialGate(t, ports["database"])
		send(t, plain, pgStartup)
		wantPGRefusal(t, plain)
		if _, err := plain.Read(make([]byte, 1)); err == nil {
			t.Fatal("the refused connection stayed open")
		}
		select {
		case got := <-db.conns:
			t.Fatalf("the database got a refused login: %q", got)
		case <-time.After(100 * time.Millisecond):
		}

		tlsClient := dialGate(t, ports["database"])
		send(t, tlsClient, pgSSLRequest)
		answer := make([]byte, 1)
		if _, err := io.ReadFull(tlsClient, answer); err != nil || answer[0] != 'S' {
			t.Fatalf("answer = %q, %v", answer, err)
		}
		if got := <-db.conns; !bytes.Equal(got, pgSSLRequest) {
			t.Fatalf("the database got %q", got)
		}
	})
	t.Run("mysql", func(t *testing.T) {
		request := mysqlResponse(0x0000_8200|mysqlClientSSL, "")
		db := recordingServer(t, mysqlGreeting, nil, len(request))
		m := newManager(t, db.addr)
		ports, err := m.Sync(context.Background(), "my", []Listener{{ID: "database", ContainerPort: 3306, RequireTLS: TLSCheckMySQL}})
		if err != nil {
			t.Fatal(err)
		}
		greeting := make([]byte, len(mysqlGreeting))
		plain := dialGate(t, ports["database"])
		if _, err := io.ReadFull(plain, greeting); err != nil || !bytes.Equal(greeting, mysqlGreeting) {
			t.Fatalf("greeting = %q, %v", greeting, err)
		}
		send(t, plain, mysqlResponse(0x0000_8200, "root\x00"))
		head := make([]byte, 5)
		if _, err := io.ReadFull(plain, head); err != nil || head[4] != 0xFF {
			t.Fatalf("plain login got %q, %v", head, err)
		}
		if got := <-db.conns; len(got) != 0 {
			t.Fatalf("the database got a refused login: %q", got)
		}

		ssl := dialGate(t, ports["database"])
		if _, err := io.ReadFull(ssl, greeting); err != nil {
			t.Fatal(err)
		}
		send(t, ssl, request)
		if got := <-db.conns; !bytes.Equal(got, request) {
			t.Fatalf("the database got %q, want %q", got, request)
		}
	})
}

func TestListenersForChecksTLSByEngine(t *testing.T) {
	want := map[agentv1.DatabaseEngine]struct {
		terminate bool
		check     TLSCheck
	}{
		agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:   {false, TLSCheckPostgres},
		agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL:      {false, TLSCheckMySQL},
		agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:    {false, TLSCheckMySQL},
		agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:      {true, TLSCheckNone},
		agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE: {true, TLSCheckNone},
		agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY:     {true, TLSCheckNone},
	}
	for e, w := range want {
		spec := &agentv1.ServiceSpec{Id: "d", KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: e,
			Exposure: &agentv1.DatabaseExposure{Enabled: true}}}}
		ls, _ := ListenersFor(spec)
		if len(ls) != 1 || ls[0].TerminateTLS != w.terminate || ls[0].RequireTLS != w.check {
			t.Errorf("%v: %+v", e, ls)
		}
	}
	// Every engine's exposed port is TLS only one way: terminated here or
	// checked here, never neither.
	for n := range agentv1.DatabaseEngine_name {
		e := agentv1.DatabaseEngine(n)
		if e != agentv1.DatabaseEngine_DATABASE_ENGINE_UNSPECIFIED && dbengine.TLSAtGate(e) == (tlsCheckFor(e) != TLSCheckNone) {
			t.Errorf("%v: TLS at the gate %v, checked %v", e, dbengine.TLSAtGate(e), tlsCheckFor(e))
		}
	}
}
