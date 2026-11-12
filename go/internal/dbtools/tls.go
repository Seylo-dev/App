package dbtools

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/seylo-dev/app/go/internal/datadir"
)

// CertSource returns the certificate the edge obtained for a host
// (proxy.Certificates); an error means none yet.
type CertSource func(host string) (certPEM, keyPEM []byte, err error)

// tlsMaterial is the server certificate installed in a database.
type tlsMaterial struct {
	certPEM, keyPEM []byte
	// selfSigned is true until an ACME certificate replaces it.
	selfSigned bool
}

func (m tlsMaterial) fingerprint() string {
	h := sha256.Sum256(m.certPEM)
	return hex.EncodeToString(h[:8])
}

// fallbackMu keeps one reader or writer of the self-signed files at a
// time: the portgate asks for them on every handshake and ExposedTLS on
// every pass, and two writers could leave one's key next to the other's
// certificate.
var fallbackMu sync.Mutex

// certFor picks the ACME certificate for host when there is one, else a
// self-signed one kept in dir/<serviceID>.{crt,key} so clients that pin it
// keep working across agent restarts. A kept one that is not of the
// current kind or does not name host (staleFallback) is made again once.
func certFor(acme CertSource, dir, serviceID, host string) (tlsMaterial, error) {
	if host != "" && acme != nil {
		if c, k, err := acme(host); err == nil && len(c) > 0 && len(k) > 0 {
			return tlsMaterial{certPEM: c, keyPEM: k}, nil
		}
	}
	if _, err := datadir.New("/").ServiceDir(serviceID); err != nil {
		return tlsMaterial{}, err
	}
	fallbackMu.Lock()
	defer fallbackMu.Unlock()
	certPath, keyPath := filepath.Join(dir, serviceID+".crt"), filepath.Join(dir, serviceID+".key")
	c, cerr := os.ReadFile(certPath)
	k, kerr := os.ReadFile(keyPath)
	if cerr == nil && kerr == nil && !staleFallback(c, host) {
		return tlsMaterial{certPEM: c, keyPEM: k, selfSigned: true}, nil
	}
	if !errors.Is(cerr, os.ErrNotExist) && cerr != nil {
		return tlsMaterial{}, cerr
	}
	c, k, err := selfSigned(host)
	if err != nil {
		return tlsMaterial{}, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return tlsMaterial{}, err
	}
	// The key first: a stop between the two leaves a missing or old
	// certificate, which is made again next time.
	if err := writeFile(keyPath, k, 0o600); err != nil {
		return tlsMaterial{}, err
	}
	if err := writeFile(certPath, c, 0o644); err != nil {
		return tlsMaterial{}, err
	}
	return tlsMaterial{certPEM: c, keyPEM: k, selfSigned: true}, nil
}

// writeFile replaces path in one rename.
func writeFile(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// staleFallback reports a kept self-signed certificate to make again:
//   - one from agents before 0.2.12, a leaf without keyCertSign. BoringSSL
//     (Bun) and OpenSSL 1.1 do not take it as self-signed, so their clients
//     (node-postgres on Bun) refused it with "unable to verify the first
//     certificate" instead of "self-signed certificate", and LibreSSL did
//     not trust it by its file either; OpenSSL 3 called it self-signed.
//   - one without the name constraints or with CA:TRUE (selfSigned says
//     why neither is wanted).
//   - one that does not name host: it was made before the TLS host name
//     was set (or for another one), and a client that trusts the file
//     and checks the name refuses it. Without a host name any kept one
//     stays, since clients then check the certificate but not the name.
//   - one that does not parse.
func staleFallback(certPEM []byte, host string) bool {
	b, _ := pem.Decode(certPEM)
	if b == nil || b.Type != "CERTIFICATE" {
		return true
	}
	c, err := x509.ParseCertificate(b.Bytes)
	if err != nil {
		return true
	}
	if c.KeyUsage&x509.KeyUsageCertSign == 0 || c.IsCA || !c.BasicConstraintsValid ||
		!c.PermittedDNSDomainsCritical || len(c.PermittedDNSDomains) == 0 {
		return true
	}
	return host != "" && !slices.Equal(c.DNSNames, []string{host})
}

// Certificate returns the certificate an exposed database serves: the ACME
// one for host when the edge has it, else the kept self-signed one (the
// same files Postgres and MySQL get). The portgate uses it to terminate
// TLS for Mongo and Redis.
func Certificate(acme CertSource, dir, serviceID, host string) (certPEM, keyPEM []byte, err error) {
	m, err := certFor(acme, dir, serviceID, host)
	if err != nil {
		return nil, nil, err
	}
	return m.certPEM, m.keyPEM, nil
}

// selfSigned makes a 10-year ECDSA P-256 certificate for host, signed by
// its own key: CA:FALSE, digitalSignature and keyCertSign, serverAuth,
// host as its DNS name, and critical name constraints that permit only
// host (and its subdomains), or only the reserved "invalid" without a host
// name, and no IP address.
//
// Each part is there for a client that was checked against it (by hand,
// Bun 1.4 BoringSSL, Node 24 OpenSSL 3.5, OpenSSL 3.6 and 4.1 with
// -x509_strict and Python 3.15's strict default, LibreSSL, rustls 0.23,
// Go):
//   - keyCertSign: BoringSSL and OpenSSL 1.1 call a certificate
//     self-signed only when its key usage allows signing certificates, and
//     LibreSSL accepts it as its own trust anchor only then. Without it
//     node-postgres on Bun says "unable to verify the first certificate".
//   - CA:FALSE: rustls (webpki) refuses a CA certificate served as the
//     server's own (CaUsedAsEndEntity), even when it trusts the file, so
//     `openssl req -x509` style CA:TRUE does not work for Rust clients.
//   - name constraints: a client that trusts the file uses it as a trust
//     anchor, and BoringSSL and LibreSSL do not look at an anchor's basic
//     constraints (rustls not at its key usage either), so without them a
//     certificate signed with this key for any other name would pass
//     where the file is trusted for the whole process
//     (NODE_EXTRA_CA_CERTS, a system store). The key sits in the database
//     container, readable by its superuser (pg_read_file). OpenSSL 3 and
//     Go refuse such a chain anyway (CA:FALSE).
//
// The certificate verifies against its own file wherever a client checks
// the certificate; with a host name the name check passes too, without one
// only clients that skip it (libpq verify-ca, MySQL VERIFY_CA) connect.
func selfSigned(host string) (certPEM, keyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		return nil, nil, err
	}
	cn, permitted := host, host
	if host == "" {
		cn, permitted = "database", "invalid"
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: cn},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  false,

		PermittedDNSDomainsCritical: true,
		PermittedDNSDomains:         []string{permitted},
		ExcludedIPRanges:            []*net.IPNet{{IP: net.IPv4zero.To4(), Mask: net.CIDRMask(0, 32)}, {IP: net.IPv6zero, Mask: net.CIDRMask(0, 128)}},
	}
	if host != "" {
		tmpl.DNSNames = []string{host}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, fmt.Errorf("making a database certificate: %w", err)
	}
	kder, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kder}), nil
}
