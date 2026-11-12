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

// caIssued returns a certificate for host issued by a separate CA, as an
// ACME certificate is.
func caIssued(t *testing.T, host string, notAfter time.Time) ([]byte, []byte) {
	t.Helper()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "R11"}, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: notAfter, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: host}, DNSNames: []string{host},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: notAfter}
	der, err := x509.CreateCertificate(rand.Reader, leaf, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	kder, _ := x509.MarshalECPrivateKey(key)
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder})
}

// An exposed Postgres or MySQL port reports the certificate the agent
// installs in the database, and a self-signed one says so, with its PEM
// and the edge's last ACME error for the TLS host name: why it is not a
// trusted one. An ACME certificate has neither; MariaDB, which serves
// its own, reports nothing.
func TestPortsReportTheDatabaseCertificate(t *testing.T) {
	expires := time.Now().Add(30 * 24 * time.Hour).Truncate(time.Second)
	selfPEM, selfKey := testCert(t, "db.example.com", expires)
	acmePEM, acmeKey := caIssued(t, "db.example.com", expires)
	acme := false
	var asked []string
	m := New(Config{
		BindIP: "127.0.0.1",
		Certificate: func(_, host string) ([]byte, []byte, error) {
			if acme && host != "" {
				return acmePEM, acmeKey, nil
			}
			return selfPEM, selfKey, nil
		},
		CertificateFailure: func(host string) (string, bool) {
			asked = append(asked, host)
			if host == "db.example.com" {
				return "Invalid response from http://db.example.com/.well-known/acme-challenge/x: 404", true
			}
			return "", false
		},
	})
	t.Cleanup(m.Close)
	spec := func(engine agentv1.DatabaseEngine, host string) *agentv1.ServiceSpec {
		return &agentv1.ServiceSpec{Id: "d1", Kind: agentv1.ServiceKind_SERVICE_KIND_DATABASE,
			KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: engine,
				Exposure: &agentv1.DatabaseExposure{Enabled: true, TlsHostname: host}}}}
	}
	port := func(engine agentv1.DatabaseEngine, host string) *agentv1.OpenPort {
		t.Helper()
		ls, errs := ListenersFor(spec(engine, host))
		if len(errs) != 0 || len(ls) != 1 {
			t.Fatalf("listeners %+v %v", ls, errs)
		}
		if _, err := m.Sync(context.Background(), "d1", ls); err != nil {
			t.Fatal(err)
		}
		open := m.Ports("d1")
		if len(open) != 1 {
			t.Fatalf("ports %v", open)
		}
		return open[0]
	}
	selfBlock, _ := pem.Decode(selfPEM)
	wantPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: selfBlock.Bytes}))

	for _, engine := range []agentv1.DatabaseEngine{agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL} {
		// No host name: self-signed, with nothing to ask the edge.
		asked = nil
		p := port(engine, "")
		if p.GetTls() || !p.GetCertificateSelfSigned() || p.GetCertificatePem() != wantPEM || p.GetCertificateError() != "" ||
			p.GetCertificateIssuer() != "db.example.com" || !p.GetCertificateExpiresAt().AsTime().Equal(expires) {
			t.Fatalf("%v without a host: %v", engine, p)
		}
		if len(asked) != 0 {
			t.Fatalf("asked the edge about %v", asked)
		}
		// A host name the CA could not reach: still self-signed, and why.
		p = port(engine, "db.example.com")
		if !p.GetCertificateSelfSigned() || p.GetCertificateError() != "Invalid response from http://db.example.com/.well-known/acme-challenge/x: 404" ||
			p.GetCertificatePem() != wantPEM {
			t.Fatalf("%v with a failing host: %v", engine, p)
		}
	}
	// The same for a port the gate terminates.
	if p := port(agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, "db.example.com"); !p.GetTls() || !p.GetCertificateSelfSigned() || p.GetCertificateError() == "" {
		t.Fatalf("mongo: %v", p)
	}

	// The ACME certificate arrived: issuer and expiry only.
	acme = true
	for _, engine := range []agentv1.DatabaseEngine{agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO} {
		p := port(engine, "db.example.com")
		if p.GetCertificateSelfSigned() || p.GetCertificatePem() != "" || p.GetCertificateError() != "" || p.GetCertificateIssuer() != "R11" {
			t.Fatalf("%v with ACME: %v", engine, p)
		}
	}

	// MariaDB serves the certificate it makes: nothing to report.
	acme = false
	if p := port(agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB, ""); p.GetCertificateIssuer() != "" || p.GetCertificateSelfSigned() || p.GetCertificatePem() != "" {
		t.Fatalf("mariadb: %v", p)
	}
}
