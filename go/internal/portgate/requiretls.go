package portgate

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// TLSCheck is how the gate makes sure a client of a database that
// negotiates TLS inside its own protocol asks for it (Listener.RequireTLS).
// The exposed port of such a database has no user of its own, so a plain
// login there is refused by the gate before it reaches the database.
type TLSCheck int

const (
	// TLSCheckNone relays whatever the client sends.
	TLSCheckNone TLSCheck = iota
	// TLSCheckPostgres: the client speaks first and must open with an
	// SSLRequest, a direct TLS ClientHello (Postgres 17
	// sslnegotiation=direct) or a CancelRequest (no credentials). A
	// GSSENCRequest gets "N" from the gate, and the next message must then
	// ask for TLS. A database that answers the SSLRequest with "N" (its TLS
	// is not on yet) gets no plain login either.
	TLSCheckPostgres
	// TLSCheckMySQL (MySQL and MariaDB): the server's greeting is relayed,
	// then the client's first packet must set CLIENT_SSL.
	TLSCheckMySQL
)

// tlsCheckFor is the check of an engine's exposed port; TLSCheckNone for
// the engines whose TLS the gate terminates itself (dbengine.TLSAtGate).
func tlsCheckFor(e agentv1.DatabaseEngine) TLSCheck {
	switch e {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		return TLSCheckPostgres
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		return TLSCheckMySQL
	}
	return TLSCheckNone
}

// How long the gate waits for the bytes it checks: a Postgres client
// sends its first message at once; a MySQL client answers the greeting
// after the server spoke, and the greeting comes from a database that may
// be busy.
const (
	postgresStartWait = 10 * time.Second
	mysqlStartWait    = 30 * time.Second
)

// errPlainClient: the client did not ask for TLS and got the protocol's
// error.
var errPlainClient = errors.New("the client did not ask for TLS")

// Postgres startup codes and limits (src/include/libpq/pqcomm.h).
const (
	pgCancelRequestCode = 80877102
	pgSSLRequestCode    = 80877103
	pgGSSENCRequestCode = 80877104
	// pgMaxStartupPacket is the server's MAX_STARTUP_PACKET_LENGTH: a
	// refused startup message up to this long is read to its end, so
	// closing does not reset the connection before the client reads the
	// error.
	pgMaxStartupPacket = 10000
	// tlsHandshakeRecord is the first byte of a TLS ClientHello.
	tlsHandshakeRecord = 0x16
)

const postgresRefusal = "this port only accepts TLS connections: connect with sslmode=require"

// postgresStart reads a Postgres client's opening message (8 bytes) and
// returns it for the database; sslRequest reports an SSLRequest, which the
// database answers with one byte (postgresAnswer). A GSSENCRequest is
// answered "N" here and the next message checked. Anything else is
// refused with an ErrorResponse (FATAL, 28000).
func postgresStart(c net.Conn, wait time.Duration) (first []byte, sslRequest bool, err error) {
	_ = c.SetDeadline(time.Now().Add(wait))
	defer func() { _ = c.SetDeadline(time.Time{}) }()
	buf := make([]byte, 8)
	for gss := false; ; gss = true {
		if _, err := io.ReadFull(c, buf); err != nil {
			return nil, false, err
		}
		if buf[0] == tlsHandshakeRecord {
			return buf, false, nil
		}
		length, code := binary.BigEndian.Uint32(buf[:4]), binary.BigEndian.Uint32(buf[4:])
		switch {
		case length == 8 && code == pgSSLRequestCode:
			return buf, true, nil
		case length == 16 && code == pgCancelRequestCode && !gss:
			return buf, false, nil
		case length == 8 && code == pgGSSENCRequestCode && !gss:
			// No GSSAPI encryption here: libpq goes on with an SSLRequest
			// on the same connection, which the database then sees first.
			if _, err := c.Write([]byte{'N'}); err != nil {
				return nil, false, err
			}
			continue
		}
		refusePostgres(c, length)
		return nil, false, errPlainClient
	}
}

// postgresAnswer relays the database's answer to an SSLRequest. "S" goes
// on to TLS. "N" (the database has no TLS yet) is passed on too, and the
// plain startup message a client may then send is refused, so the port
// stays TLS only while the agent turns TLS on.
func postgresAnswer(client, upstream net.Conn, wait time.Duration) error {
	_ = upstream.SetReadDeadline(time.Now().Add(wait))
	var b [1]byte
	_, err := io.ReadFull(upstream, b[:])
	_ = upstream.SetReadDeadline(time.Time{})
	if err != nil {
		return err
	}
	_ = client.SetDeadline(time.Now().Add(wait))
	defer func() { _ = client.SetDeadline(time.Time{}) }()
	if _, err := client.Write(b[:]); err != nil {
		return err
	}
	if b[0] == 'S' {
		return nil
	}
	if b[0] != 'N' {
		return fmt.Errorf("unexpected answer %q to an SSLRequest", b[0])
	}
	var head [8]byte
	if _, err := io.ReadFull(client, head[:]); err != nil {
		return err
	}
	refusePostgres(client, binary.BigEndian.Uint32(head[:4]))
	return errPlainClient
}

// refusePostgres reads the rest of a startup message of length (its first
// 8 bytes are read) and sends the ErrorResponse a server sends to a login
// it refuses.
func refusePostgres(c net.Conn, length uint32) {
	if length > 8 && length <= pgMaxStartupPacket {
		_, _ = io.CopyN(io.Discard, c, int64(length-8))
	}
	_, _ = c.Write(postgresError(postgresRefusal))
}

// postgresError is an ErrorResponse with severity FATAL and SQLSTATE 28000
// (invalid_authorization_specification), as libpq prints it.
func postgresError(message string) []byte {
	var body []byte
	for _, f := range []struct {
		code  byte
		value string
	}{{'S', "FATAL"}, {'V', "FATAL"}, {'C', "28000"}, {'M', message}} {
		body = append(body, f.code)
		body = append(body, f.value...)
		body = append(body, 0)
	}
	body = append(body, 0)
	out := []byte{'E', 0, 0, 0, 0}
	binary.BigEndian.PutUint32(out[1:], uint32(4+len(body)))
	return append(out, body...)
}

// MySQL protocol values.
const (
	mysqlClientSSL = 0x0800
	// mysqlMaxDrain bounds how much of a refused handshake response is
	// read before the error (a response with connection attributes is a
	// few hundred bytes).
	mysqlMaxDrain = 1 << 16
	// mysqlInsecureTransport is ER_SECURE_TRANSPORT_REQUIRED.
	mysqlInsecureTransport = 3159
)

const mysqlRefusal = "Connections using insecure transport are prohibited on this port: connect with TLS (mysql --ssl-mode=REQUIRED, mariadb --ssl)"

// mysqlStart relays the server's first packet (its greeting, or an error)
// to the client, then reads the head of the client's answer: the packet
// header and the low 16 bits of its capability flags, returned for the
// database. A client that does not set CLIENT_SSL gets an ERR packet
// (3159, HY000) with the next sequence id.
func mysqlStart(client, upstream net.Conn, wait time.Duration) ([]byte, error) {
	deadline := time.Now().Add(wait)
	_ = upstream.SetReadDeadline(deadline)
	_ = client.SetDeadline(deadline)
	defer func() {
		_ = upstream.SetReadDeadline(time.Time{})
		_ = client.SetDeadline(time.Time{})
	}()
	var header [4]byte
	if _, err := io.ReadFull(upstream, header[:]); err != nil {
		return nil, err
	}
	if _, err := client.Write(header[:]); err != nil {
		return nil, err
	}
	if _, err := io.CopyN(client, upstream, int64(mysqlLength(header[:]))); err != nil {
		return nil, err
	}
	head := make([]byte, 6)
	if _, err := io.ReadFull(client, head[:4]); err != nil {
		return nil, err
	}
	length, seq := mysqlLength(head), head[3]
	if length >= 2 {
		if _, err := io.ReadFull(client, head[4:]); err != nil {
			return nil, err
		}
		if binary.LittleEndian.Uint16(head[4:])&mysqlClientSSL != 0 {
			return head, nil
		}
		length -= 2
	}
	_, _ = io.CopyN(io.Discard, client, int64(min(length, mysqlMaxDrain)))
	_, _ = client.Write(mysqlError(seq+1, mysqlInsecureTransport, "HY000", mysqlRefusal))
	return nil, errPlainClient
}

// mysqlLength is the payload length in a packet header (3 bytes, little
// endian).
func mysqlLength(header []byte) uint32 {
	return uint32(header[0]) | uint32(header[1])<<8 | uint32(header[2])<<16
}

// mysqlError is an ERR packet as a 4.1 client reads it: 0xFF, the error
// code, "#" and the SQLSTATE, then the message.
func mysqlError(seq byte, code uint16, state, message string) []byte {
	payload := []byte{0xFF, byte(code), byte(code >> 8), '#'}
	payload = append(payload, state...)
	payload = append(payload, message...)
	n := len(payload)
	return append([]byte{byte(n), byte(n >> 8), byte(n >> 16), seq}, payload...)
}
