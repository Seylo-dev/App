package portgate

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// ErrNoCertificates refuses a TLS-terminating listener on a gate built
// without Config.Certificate.
var ErrNoCertificates = errors.New("this gate has no certificates for TLS ports")

// tlsConfig serves the service's certificate, looked up per handshake.
func (m *Manager) tlsConfig(serviceID, host string) *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			certPEM, keyPEM, err := m.cfg.Certificate(serviceID, host)
			if err != nil {
				m.log.Warn("portgate certificate", "service_id", serviceID, "err", err)
				return nil, err
			}
			c, err := tls.X509KeyPair(certPEM, keyPEM)
			if err != nil {
				return nil, err
			}
			return &c, nil
		},
	}
}

// certInfo reads the issuer and expiry of the certificate a TLS port
// serves now.
func (m *Manager) certInfo(serviceID, host string) (string, time.Time, bool) {
	if m.cfg.Certificate == nil {
		return "", time.Time{}, false
	}
	certPEM, keyPEM, err := m.cfg.Certificate(serviceID, host)
	if err != nil {
		return "", time.Time{}, false
	}
	c, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil || len(c.Certificate) == 0 {
		return "", time.Time{}, false
	}
	leaf, err := x509.ParseCertificate(c.Certificate[0])
	if err != nil {
		return "", time.Time{}, false
	}
	issuer := leaf.Issuer.CommonName
	if issuer == "" && len(leaf.Issuer.Organization) > 0 {
		issuer = leaf.Issuer.Organization[0]
	}
	return issuer, leaf.NotAfter, true
}

// terminatesTLS reports the engines whose exposed port the gate wraps in
// TLS itself: they speak TLS from the first byte, so a relay can
// terminate it (Postgres, MySQL and MariaDB negotiate TLS inside their
// protocol and use their own).
func terminatesTLS(engine agentv1.DatabaseEngine) bool {
	return engine == agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO || engine == agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS
}
