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
	"os"
	"path/filepath"
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
// keep working across agent restarts. A kept one from before 0.2.12
// (oldFallback) is made again once, as its own root.
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
	if cerr == nil && kerr == nil && !oldFallback(c) {
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

// oldFallback reports a kept self-signed certificate from agents before
// 0.2.12: a leaf without keyCertSign. BoringSSL (Bun) and OpenSSL 1.1 do
// not take it as self-signed, so their clients (node-postgres on Bun)
// refused it with "unable to verify the first certificate" instead of
// "self-signed certificate"; OpenSSL 3 called it self-signed already.
func oldFallback(certPEM []byte) bool {
	b, _ := pem.Decode(certPEM)
	if b == nil || b.Type != "CERTIFICATE" {
		return false
	}
	c, err := x509.ParseCertificate(b.Bytes)
	if err != nil {
		return false
	}
	return c.KeyUsage&x509.KeyUsageCertSign == 0
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

// selfSigned makes a 10-year ECDSA P-256 certificate for host that is its
// own root (CA, keyCertSign, path length 0), as `openssl req -x509` makes
// them: every TLS library (OpenSSL 1.1 and 3, BoringSSL in Bun, Go) calls
// it a self-signed certificate, and a client can trust it by its file
// (sslrootcert, ssl-ca, tlsCAFile).
func selfSigned(host string) (certPEM, keyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		return nil, nil, err
	}
	cn := host
	if cn == "" {
		cn = "database"
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(10, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		// Its own issuer: BoringSSL and OpenSSL 1.1 take a certificate as
		// self-signed only when it may sign certificates.
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
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
