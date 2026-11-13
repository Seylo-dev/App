package portgate

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Exposures that allow plain clients (DatabaseExposure.allow_plain): the
// checks pass a plain client on instead of refusing it, TLS clients go on
// as before, and turning it off again closes the plain sessions only.

func TestPostgresStartWithPlainAllowed(t *testing.T) {
	t.Run("a StartupMessage goes on to the database", func(t *testing.T) {
		gate, client, done := startPostgresWith(t, time.Second, true)
		go func() { _, _ = client.Write(pgStartup) }()
		r := result(t, done)
		if r.err != nil || !r.plain || r.sslRequest || !bytes.Equal(r.first, pgStartup[:8]) {
			t.Fatalf("got %+v", r)
		}
		// Only the 8 bytes it looked at were read: the rest is the relay's, and no error went out.
		rest := make([]byte, len(pgStartup)-8)
		_ = gate.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := io.ReadFull(gate, rest); err != nil || !bytes.Equal(rest, pgStartup[8:]) {
			t.Fatalf("rest = %q, %v", rest, err)
		}
	})
	t.Run("GSSENCRequest, then a StartupMessage", func(t *testing.T) {
		_, client, done := startPostgresWith(t, time.Second, true)
		send(t, client, pgGSSENCRequest)
		answer := make([]byte, 1)
		_ = client.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := io.ReadFull(client, answer); err != nil || answer[0] != 'N' {
			t.Fatalf("answer = %q, %v", answer, err)
		}
		go func() { _, _ = client.Write(pgStartup) }()
		if r := result(t, done); r.err != nil || !r.plain || !bytes.Equal(r.first, pgStartup[:8]) {
			t.Fatalf("got %+v", r)
		}
	})
	t.Run("an SSLRequest is still TLS", func(t *testing.T) {
		_, client, done := startPostgresWith(t, time.Second, true)
		send(t, client, pgSSLRequest)
		if r := result(t, done); r.err != nil || r.plain || !r.sslRequest {
			t.Fatalf("got %+v", r)
		}
	})
}

func TestPostgresAnswerWithPlainAllowed(t *testing.T) {
	for _, answer := range []byte{'N', 'S'} {
		t.Run(string(answer), func(t *testing.T) {
			gate, client := net.Pipe()
			db, dbGate := net.Pipe()
			t.Cleanup(func() { _ = gate.Close(); _ = client.Close(); _ = db.Close(); _ = dbGate.Close() })
			type res struct {
				plain bool
				err   error
			}
			done := make(chan res, 1)
			go func() {
				plain, err := postgresAnswer(gate, dbGate, time.Second, true)
				done <- res{plain, err}
			}()
			send(t, db, []byte{answer})
			got := make([]byte, 1)
			_ = client.SetReadDeadline(time.Now().Add(time.Second))
			if _, err := io.ReadFull(client, got); err != nil || got[0] != answer {
				t.Fatalf("client got %q, %v", got, err)
			}
			// "N": the plain startup that follows is the relay's, not refused here.
			r := <-done
			if r.err != nil || r.plain != (answer == 'N') {
				t.Fatalf("got %+v", r)
			}
		})
	}
}

func TestMySQLStartWithPlainAllowed(t *testing.T) {
	plainResponse := mysqlResponse(0x0000_0200|0x0000_8000|0x000f_0000, "root\x00\x20"+strings.Repeat("a", 32)+"app\x00")
	t.Run("a plain handshake response goes on to the database", func(t *testing.T) {
		s := startMySQLWith(t, time.Second, true)
		s.greet(t, mysqlGreeting)
		go func() { _, _ = s.client.Write(plainResponse) }()
		if r := result(t, s.done); r.err != nil || !r.plain || !bytes.Equal(r.first, plainResponse[:4]) {
			t.Fatalf("got %+v", r)
		}
	})
	t.Run("a 32-byte answer without CLIENT_SSL", func(t *testing.T) {
		s := startMySQLWith(t, time.Second, true)
		s.greet(t, mysqlGreeting)
		short := mysqlResponse(0x0000_8200, "")
		go func() { _, _ = s.client.Write(short) }()
		if r := result(t, s.done); r.err != nil || !r.plain || !bytes.Equal(r.first, short[:6]) {
			t.Fatalf("got %+v", r)
		}
	})
	t.Run("a database without TLS gets its greeting to the client", func(t *testing.T) {
		s := startMySQLWith(t, time.Second, true)
		s.greet(t, mysqlHandshake("5.5.5-10.11.13-MariaDB-ubu2204", 0xffff&^mysqlClientSSL))
		go func() { _, _ = s.client.Write(plainResponse) }()
		if r := result(t, s.done); r.err != nil || !r.plain || !bytes.Equal(r.first, plainResponse[:4]) {
			t.Fatalf("got %+v", r)
		}
	})
	t.Run("an SSLRequest is still TLS", func(t *testing.T) {
		s := startMySQLWith(t, time.Second, true)
		s.greet(t, mysqlGreeting)
		request := mysqlResponse(0x0000_8200|mysqlClientSSL, "")
		go func() { _, _ = s.client.Write(request) }()
		if r := result(t, s.done); r.err != nil || r.plain || !bytes.Equal(r.first, request[:6]) {
			t.Fatalf("got %+v", r)
		}
	})
	t.Run("the server's error still goes to the client as it is", func(t *testing.T) {
		s := startMySQLWith(t, time.Second, true)
		s.greet(t, mysqlError(0, 1040, "08004", "Too many connections"))
		if r := result(t, s.done); !errors.Is(r.err, errUpstreamRefused) {
			t.Fatalf("got %+v", r)
		}
	})
}

// realClientHello is the first flight of Go's TLS client.
func realClientHello(t *testing.T) []byte {
	t.Helper()
	gate, client := net.Pipe()
	defer gate.Close()
	go func() {
		_ = tls.Client(client, &tls.Config{ServerName: "db.example.com", InsecureSkipVerify: true}).Handshake()
		_ = client.Close()
	}()
	_ = gate.SetReadDeadline(time.Now().Add(2 * time.Second))
	hello := make([]byte, 64)
	if _, err := io.ReadFull(gate, hello); err != nil {
		t.Fatal(err)
	}
	return hello
}

func TestClientHello(t *testing.T) {
	// A MongoDB request 790 bytes long starts 0x16 0x03 like a TLS record; its
	// responseTo (0 in a request) is where the ClientHello has its version.
	mongo := binary.LittleEndian.AppendUint32(nil, 0x0316)
	mongo = binary.LittleEndian.AppendUint32(mongo, 0x0101) // requestID: byte 5 is 1, as a ClientHello's type
	mongo = binary.LittleEndian.AppendUint32(mongo, 0)      // responseTo
	mongo = binary.LittleEndian.AppendUint32(mongo, 2013)   // OP_MSG
	cases := map[string]struct {
		sent  []byte
		isTLS bool
		head  int
	}{
		"a TLS ClientHello":                   {realClientHello(t), true, clientHelloHead},
		"a Redis command":                     {[]byte("*1\r\n$4\r\nPING\r\n"), false, 1},
		"an inline Redis command":             {[]byte("PING\r\n"), false, 1},
		"ClickHouse's native Hello":           {[]byte{0, 10, 'C', 'l', 'i', 'c', 'k', 'H', 'o', 'u', 's', 'e'}, false, 1},
		"a MongoDB message like a TLS record": {mongo, false, clientHelloHead},
		"a TLS record that is no ClientHello": {[]byte{0x16, 3, 3, 0, 4, 2, 0, 0, 0, 3, 3}, false, clientHelloHead},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			gate, client := net.Pipe()
			t.Cleanup(func() { _ = gate.Close(); _ = client.Close() })
			go func() { _, _ = client.Write(c.sent) }()
			// A short plain command is not waited on: one byte tells it apart.
			head, isTLS, err := clientHello(gate, time.Second)
			if err != nil || isTLS != c.isTLS || !bytes.Equal(head, c.sent[:c.head]) {
				t.Fatalf("head %q, TLS %v, %v", head, isTLS, err)
			}
			// What it read comes first again, then the rest.
			replay := &replayConn{Conn: gate, head: head}
			got := make([]byte, len(c.sent))
			_ = gate.SetReadDeadline(time.Now().Add(time.Second))
			if _, err := io.ReadFull(replay, got); err != nil || !bytes.Equal(got, c.sent) {
				t.Fatalf("replayed %q, %v", got, err)
			}
		})
	}
	t.Run("waits a bounded time", func(t *testing.T) {
		gate, client := net.Pipe()
		t.Cleanup(func() { _ = gate.Close(); _ = client.Close() })
		var ne net.Error
		if _, _, err := clientHello(gate, 50*time.Millisecond); !errors.As(err, &ne) || !ne.Timeout() {
			t.Fatalf("err = %v, want a timeout", err)
		}
	})
}

func TestListenersForCarriesAllowPlain(t *testing.T) {
	for _, on := range []bool{false, true} {
		spec := &agentv1.ServiceSpec{Id: "d", KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{
			Engine: agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, Exposure: &agentv1.DatabaseExposure{Enabled: true, AllowPlain: on}}}}
		ls, _ := ListenersFor(spec)
		if len(ls) != 1 || ls[0].AllowPlain != on || ls[0].RequireTLS != TLSCheckMySQL {
			t.Fatalf("allow_plain %v: %+v", on, ls)
		}
	}
}

// closedByGate reports whether a session the gate relayed gets closed.
func closedByGate(c net.Conn) bool {
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, err := c.Read(make([]byte, 1))
	var ne net.Error
	return err != nil && !(errors.As(err, &ne) && ne.Timeout())
}

// A gate-terminated port (the Redis-like engines, Mongo, ClickHouse): plain
// allowed relays plain clients as they are, TLS clients still get the gate's
// TLS, and switching either way keeps the socket and the TLS sessions.
func TestPlainClientsOnATLSTerminatingPort(t *testing.T) {
	upstream := pongServer(t)
	certPEM, keyPEM := testCert(t, "redis.example.com", time.Now().Add(24*time.Hour))
	m := newManager(t, upstream, func(c *Config) {
		c.Certificate = func(string, string) ([]byte, []byte, error) { return certPEM, keyPEM, nil }
	})
	listener := func(allowPlain bool) []Listener {
		return []Listener{{ID: "database", ContainerPort: 6379, TerminateTLS: true, TLSHost: "redis.example.com", AllowPlain: allowPlain}}
	}
	sync := func(allowPlain bool) uint32 {
		t.Helper()
		ports, err := m.Sync(context.Background(), "r1", listener(allowPlain))
		if err != nil {
			t.Fatal(err)
		}
		return ports["database"]
	}
	port := sync(false)
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port)))
	ping := func(c net.Conn, word string) error {
		_ = c.SetDeadline(time.Now().Add(2 * time.Second))
		if _, err := io.WriteString(c, word+"\n"); err != nil {
			return err
		}
		line, err := bufio.NewReader(c).ReadString('\n')
		if err != nil {
			return err
		}
		if line != "+PONG "+word+"\r\n" {
			return errors.New("answer " + line)
		}
		return nil
	}
	dialTLS := func() net.Conn {
		t.Helper()
		c, err := tls.Dial("tcp", addr, &tls.Config{InsecureSkipVerify: true})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Close() })
		return c
	}
	dialPlain := func() net.Conn {
		t.Helper()
		c, err := net.DialTimeout("tcp", addr, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Close() })
		return c
	}

	// Off: TLS only, as always.
	before := dialTLS()
	if err := ping(before, "one"); err != nil {
		t.Fatal(err)
	}
	if err := ping(dialPlain(), "plain"); err == nil {
		t.Fatal("a plain client reached the database with plain off")
	}

	// On: the same socket, the TLS session opened before goes on, and plain clients reach the database.
	if p := sync(true); p != port {
		t.Fatalf("the port moved from %d to %d", port, p)
	}
	if err := ping(before, "two"); err != nil {
		t.Fatalf("the TLS session opened before: %v", err)
	}
	plain := dialPlain()
	if err := ping(plain, "plain"); err != nil {
		t.Fatalf("plain client with plain on: %v", err)
	}
	tlsAfter := dialTLS()
	if err := ping(tlsAfter, "three"); err != nil {
		t.Fatalf("TLS client with plain on: %v", err)
	}
	// The allow list still applies to both.
	ports, err := m.Sync(context.Background(), "r1", []Listener{{ID: "database", ContainerPort: 6379, TerminateTLS: true,
		TLSHost: "redis.example.com", AllowPlain: true, AllowedSourceCIDRs: []string{"192.0.2.0/24"}}})
	if err != nil || ports["database"] != port {
		t.Fatalf("ports %v, %v", ports, err)
	}
	if !closedByGate(plain) || !closedByGate(tlsAfter) {
		t.Fatal("a client outside the allow list kept its session")
	}
	if err := ping(dialPlain(), "outside"); err == nil {
		t.Fatal("a plain client outside the allow list reached the database")
	}
	sync(true)
	plain = dialPlain()
	if err := ping(plain, "again"); err != nil {
		t.Fatal(err)
	}
	tlsAfter = dialTLS()
	if err := ping(tlsAfter, "four"); err != nil {
		t.Fatal(err)
	}

	// Off again: the plain session is closed, the TLS one stays, new plain clients are refused.
	sync(false)
	if !closedByGate(plain) {
		t.Fatal("the plain session stayed open after plain was turned off")
	}
	if err := ping(tlsAfter, "five"); err != nil {
		t.Fatalf("the TLS session after plain was turned off: %v", err)
	}
	if err := ping(dialPlain(), "late"); err == nil {
		t.Fatal("a plain client reached the database after plain was turned off")
	}
}

// fakePostgres stands in for a Postgres container with TLS on: an
// SSLRequest gets "S" and a TLS handshake, a startup message is read
// whole; then it echoes lines, over TLS or not. Like a database busy with
// a query, it does not close a session whose client half-closed it.
func fakePostgres(t *testing.T) string {
	t.Helper()
	certPEM, keyPEM := testCert(t, "db", time.Now().Add(24*time.Hour))
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop); _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				head := make([]byte, 8)
				if _, err := io.ReadFull(c, head); err != nil {
					return
				}
				var conn net.Conn = c
				if binary.BigEndian.Uint32(head[4:]) == pgSSLRequestCode {
					if _, err := c.Write([]byte{'S'}); err != nil {
						return
					}
					conn = tls.Server(c, &tls.Config{Certificates: []tls.Certificate{cert}})
				} else if _, err := io.CopyN(io.Discard, c, int64(binary.BigEndian.Uint32(head)-8)); err != nil {
					return
				}
				_, _ = io.Copy(conn, conn)
				<-stop
			}()
		}
	}()
	return ln.Addr().String()
}

// Postgres through the first-packet check: the same, with the database's
// own TLS.
func TestPlainClientsOnACheckedPort(t *testing.T) {
	m := newManager(t, fakePostgres(t))
	sync := func(allowPlain bool) uint32 {
		t.Helper()
		ports, err := m.Sync(context.Background(), "pg", []Listener{{ID: "database", ContainerPort: 5432, RequireTLS: TLSCheckPostgres, AllowPlain: allowPlain}})
		if err != nil {
			t.Fatal(err)
		}
		return ports["database"]
	}
	echo := func(c net.Conn, word string) error {
		_ = c.SetDeadline(time.Now().Add(2 * time.Second))
		if _, err := io.WriteString(c, word+"\n"); err != nil {
			return err
		}
		line, err := bufio.NewReader(c).ReadString('\n')
		if err != nil {
			return err
		}
		if line != word+"\n" {
			return errors.New("answer " + line)
		}
		return nil
	}
	port := sync(false)
	plainLogin := func() net.Conn {
		t.Helper()
		c := dialGate(t, port)
		send(t, c, pgStartup)
		return c
	}
	tlsLogin := func() net.Conn {
		t.Helper()
		c := dialGate(t, port)
		send(t, c, pgSSLRequest)
		answer := make([]byte, 1)
		if _, err := io.ReadFull(c, answer); err != nil || answer[0] != 'S' {
			t.Fatalf("answer = %q, %v", answer, err)
		}
		tc := tls.Client(c, &tls.Config{InsecureSkipVerify: true})
		t.Cleanup(func() { _ = tc.Close() })
		return tc
	}

	wantPGRefusal(t, plainLogin())
	if p := sync(true); p != port {
		t.Fatalf("the port moved from %d to %d", port, p)
	}
	plain := plainLogin()
	if err := echo(plain, "plain"); err != nil {
		t.Fatalf("plain login with plain on: %v", err)
	}
	secure := tlsLogin()
	if err := echo(secure, "tls"); err != nil {
		t.Fatalf("TLS login with plain on: %v", err)
	}

	sync(false)
	if !closedByGate(plain) {
		t.Fatal("the plain session stayed open after plain was turned off")
	}
	// Its connection to the database is closed too: the relay ends at once, though the database sends nothing.
	deadline := time.Now().Add(2 * time.Second)
	for _, plainNow := m.sessions("pg"); len(plainNow) > 0; _, plainNow = m.sessions("pg") {
		if time.Now().After(deadline) {
			t.Fatal("the plain session's relay to the database stayed open")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := echo(secure, "still"); err != nil {
		t.Fatalf("the TLS session after plain was turned off: %v", err)
	}
	wantPGRefusal(t, plainLogin())
}

// MySQL through the first-packet check: a plain handshake response reaches
// the database whole once plain is on.
func TestPlainMySQLLoginReachesTheDatabase(t *testing.T) {
	response := mysqlResponse(0x0000_8200, "root\x00")
	db := recordingServer(t, mysqlGreeting, nil, len(response))
	m := newManager(t, db.addr)
	ports, err := m.Sync(context.Background(), "my", []Listener{{ID: "database", ContainerPort: 3306, RequireTLS: TLSCheckMySQL, AllowPlain: true}})
	if err != nil {
		t.Fatal(err)
	}
	c := dialGate(t, ports["database"])
	greeting := make([]byte, len(mysqlGreeting))
	if _, err := io.ReadFull(c, greeting); err != nil || !bytes.Equal(greeting, mysqlGreeting) {
		t.Fatalf("greeting = %q, %v", greeting, err)
	}
	send(t, c, response)
	if got := <-db.conns; !bytes.Equal(got, response) {
		t.Fatalf("the database got %q, want %q", got, response)
	}
}

// sessions returns the client connections of a service's database
// listener: those relayed with TLS and those relayed without.
func (m *Manager) sessions(serviceID string) (tlsConns, plainConns []net.Conn) {
	m.mu.Lock()
	a := m.open[serviceID]["database"]
	m.mu.Unlock()
	if a == nil {
		return nil, nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for c := range a.clients {
		if _, plain := a.plainClients[c]; plain {
			plainConns = append(plainConns, c)
		} else {
			tlsConns = append(tlsConns, c)
		}
	}
	return tlsConns, plainConns
}
