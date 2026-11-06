package portgate

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"strconv"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func testCert(t *testing.T, host string, notAfter time.Time) ([]byte, []byte) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(7), Subject: pkix.Name{CommonName: host}, DNSNames: []string{host},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: notAfter}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kder, _ := x509.MarshalECPrivateKey(key)
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder})
}

// pongServer answers "+PONG" to every line, like Redis to PING.
func pongServer(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				sc := bufio.NewScanner(c)
				for sc.Scan() {
					if _, err := c.Write([]byte("+PONG " + sc.Text() + "\r\n")); err != nil {
						return
					}
				}
			}()
		}
	}()
	return ln.Addr().String()
}

func TestTLSTerminatingDatabasePort(t *testing.T) {
	upstream := pongServer(t)
	expires := time.Now().Add(30 * 24 * time.Hour).Truncate(time.Second)
	certPEM, keyPEM := testCert(t, "redis.example.com", expires)
	m := New(Config{
		BindIP:  "127.0.0.1",
		Resolve: func(context.Context, string, uint32) (string, error) { return upstream, nil },
		Certificate: func(serviceID, host string) ([]byte, []byte, error) {
			if serviceID != "r1" || host != "redis.example.com" {
				return nil, nil, errors.New("wrong certificate request")
			}
			return certPEM, keyPEM, nil
		},
	})
	t.Cleanup(m.Close)
	spec := &agentv1.ServiceSpec{Id: "r1", Kind: agentv1.ServiceKind_SERVICE_KIND_DATABASE,
		KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS,
			Exposure: &agentv1.DatabaseExposure{Enabled: true, TlsHostname: "redis.example.com"}}}}
	ls, errs := ListenersFor(spec)
	if len(errs) != 0 || len(ls) != 1 || !ls[0].TerminateTLS {
		t.Fatalf("listeners %+v %v", ls, errs)
	}
	ports, err := m.Sync(context.Background(), "r1", ls)
	if err != nil {
		t.Fatal(err)
	}
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(int(ports["database"])))

	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(certPEM)
	c, err := tls.Dial("tcp", addr, &tls.Config{ServerName: "redis.example.com", RootCAs: pool})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("PING\n")); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(c).ReadString('\n')
	if err != nil || line != "+PONG PING\r\n" {
		t.Fatalf("answer %q %v", line, err)
	}

	// Plain TCP gets no answer: the port only speaks TLS.
	plain, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = plain.Write([]byte("PING\n"))
	_ = plain.SetReadDeadline(time.Now().Add(2 * time.Second))
	if b, err := bufio.NewReader(plain).ReadString('\n'); err == nil && b == "+PONG PING\r\n" {
		t.Fatal("a plain connection reached the database")
	}
	plain.Close()

	open := m.Ports("r1")
	if len(open) != 1 || !open[0].GetTls() || !open[0].GetCertificateExpiresAt().AsTime().Equal(expires) || open[0].GetCertificateIssuer() != "redis.example.com" {
		t.Fatalf("ports %v", open)
	}

	// The other Redis-like engines and ClickHouse's native port are
	// terminated by the gate too, on the engine's own port.
	for engine, port := range map[agentv1.DatabaseEngine]uint32{
		agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY:     6379,
		agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB:      6379,
		agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY:  6379,
		agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE: 9000,
	} {
		spec.GetDatabase().Engine = engine
		if ls, _ := ListenersFor(spec); !ls[0].TerminateTLS || ls[0].ContainerPort != port {
			t.Fatalf("%v listener %+v", engine, ls[0])
		}
	}
	// Postgres keeps its own TLS: a raw relay.
	spec.GetDatabase().Engine = agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES
	if ls, _ := ListenersFor(spec); ls[0].TerminateTLS {
		t.Fatal("Postgres exposure terminated by the gate")
	}
	// No certificate source: such listeners are refused.
	bare := New(Config{BindIP: "127.0.0.1"})
	t.Cleanup(bare.Close)
	if _, err := bare.Sync(context.Background(), "r1", []Listener{{ID: "database", ServiceID: "r1", ContainerPort: 6379, TerminateTLS: true}}); !errors.Is(err, ErrNoCertificates) {
		t.Fatalf("err = %v", err)
	}
}
