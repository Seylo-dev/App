package portgate

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"

	"google.golang.org/protobuf/types/known/timestamppb"

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

// reportCertificate fills an open port's certificate fields from the
// certificate the port serves now (TerminateTLS) or the agent installs in
// the database (AgentCertificate): issuer and expiry, and for a
// self-signed one its PEM and, with a TLS host name, the edge's last ACME
// error for it.
func (m *Manager) reportCertificate(p *agentv1.OpenPort, serviceID, host string) {
	leaf, ok := m.servedLeaf(serviceID, host)
	if !ok {
		return
	}
	issuer := leaf.Issuer.CommonName
	if issuer == "" && len(leaf.Issuer.Organization) > 0 {
		issuer = leaf.Issuer.Organization[0]
	}
	p.CertificateIssuer, p.CertificateExpiresAt = issuer, timestamppb.New(leaf.NotAfter)
	if !selfIssued(leaf) {
		return
	}
	p.CertificateSelfSigned = true
	p.CertificatePem = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leaf.Raw}))
	if host != "" && m.cfg.CertificateFailure != nil {
		if msg, failed := m.cfg.CertificateFailure(host); failed {
			p.CertificateError = msg
		}
	}
}

// servedLeaf parses the certificate Config.Certificate gives for the
// port; false when there is none or it does not load.
func (m *Manager) servedLeaf(serviceID, host string) (*x509.Certificate, bool) {
	if m.cfg.Certificate == nil {
		return nil, false
	}
	certPEM, keyPEM, err := m.cfg.Certificate(serviceID, host)
	if err != nil {
		return nil, false
	}
	c, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil || len(c.Certificate) == 0 {
		return nil, false
	}
	leaf, err := x509.ParseCertificate(c.Certificate[0])
	if err != nil {
		return nil, false
	}
	return leaf, true
}

// selfIssued reports a certificate that is its own issuer, signed with its
// own key: the agent's fallback, never an ACME certificate (those come
// from the CA's intermediate).
func selfIssued(c *x509.Certificate) bool {
	return bytes.Equal(c.RawIssuer, c.RawSubject) && c.CheckSignature(c.SignatureAlgorithm, c.RawTBSCertificate, c.Signature) == nil
}
