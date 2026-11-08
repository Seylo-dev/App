package proxy

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// Mutual TLS on the LB entry point (NodeSettings.lb_tls). The entry point
// is published on every interface (Docker ports bypass ufw), so without it
// anyone could reach every service there with a Host header, past the
// per-domain rate limit and redirects the entry node applies, and the
// balancing node could not tell a sibling from an attacker on the path.
// With it:
//
//   - every LB router uses the TLS options LBTLSOptions: the client must
//     present a certificate the panel issued to a current node. With
//     lb_tls.peers the client CAs are the one-off issuers of the peers'
//     certificates (each node certificate has its own, signed by the LB
//     CA), so a removed node's certificate, or one the panel replaced and
//     gave up, no longer verifies; from older panels (no peers) any
//     certificate of the LB CA. An anchor router for the shared server
//     name and the node's own name makes those SNIs pick the same options,
//     so Traefik's SNI/Host check (421) also refuses a client that sends no
//     SNI or another one;
//   - the balancing node verifies each peer against the CA by the name
//     listed for that peer (its own name once its agent answers it,
//     lbPeerName) and presents its certificate, and the one before it
//     while it has one: Go's TLS client sends the one whose issuer the peer
//     asks for, so a renewal never locks it out of a peer that has not
//     heard of the new certificate yet (lbTransport).
//
// Without lb_tls (a node whose certificate the panel could not issue yet)
// no router uses the LB entry point: it answers 404 to everyone instead of
// taking any client (routes.go, lbRouters).

// LBTLSOptions names the TLS options of the LB routers.
const LBTLSOptions = brand.Slug + "-lb"

// LBPeersCapability is what agents that answer LoadBalancerTls's
// node_server_name and use its peers advertise. The panel lists a node
// under its own name only once its agent advertises this; before that
// other nodes reach it by the shared server name.
const LBPeersCapability = "lb.tls.peers.v1"

// LBTLSFile holds the LB entry point's TLS options, certificate and anchor
// router. The dot keeps it apart from route files: Prune and the Wings
// fork's pruning never take it for a service's file.
const LBTLSFile = docker.RouteFilePrefix + "lb.tls.yml"

// lbTLSOf returns the complete LB TLS settings, or nil.
func lbTLSOf(s *agentv1.NodeSettings) *agentv1.LoadBalancerTls {
	lb := s.GetLbTls()
	if lb.GetCaPem() == "" || lb.GetCertPem() == "" || lb.GetKeyPem() == "" || lb.GetServerName() == "" {
		return nil
	}
	return lb
}

// ErrBadLBTLS means NodeSettings.lb_tls cannot be used.
var ErrBadLBTLS = errors.New("invalid load balancer TLS settings")

// lbNames are the names this node's certificate must be valid for and its
// entry point answers: the shared server name, then its own when set.
func lbNames(lb *agentv1.LoadBalancerTls) []string {
	names := []string{lb.GetServerName()}
	if own := lb.GetNodeServerName(); own != "" && own != lb.GetServerName() {
		names = append(names, own)
	}
	return names
}

// checkLBTLS makes sure the CA parses, the key matches the certificate and
// the certificate is valid for the server name (and the node's own name)
// under that CA, for both server and client auth.
func checkLBTLS(lb *agentv1.LoadBalancerTls) error {
	for _, name := range lbNames(lb) {
		if err := checkHost(name); err != nil {
			return fmt.Errorf("%w: server name: %w", ErrBadLBTLS, err)
		}
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(lb.GetCaPem())) {
		return fmt.Errorf("%w: no CA certificate", ErrBadLBTLS)
	}
	leaf, inter, err := lbPair(lb.GetCertPem(), lb.GetKeyPem())
	if err != nil {
		return fmt.Errorf("%w: %w", ErrBadLBTLS, err)
	}
	for _, name := range lbNames(lb) {
		for _, usage := range []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth} {
			if _, err := leaf.Verify(x509.VerifyOptions{DNSName: name, Roots: pool, Intermediates: inter, KeyUsages: []x509.ExtKeyUsage{usage}}); err != nil {
				return fmt.Errorf("%w: %w", ErrBadLBTLS, err)
			}
		}
	}
	return nil
}

// lbPair parses a certificate chain and its key: the leaf and the rest of
// the chain as intermediates.
func lbPair(certPEM, keyPEM string) (*x509.Certificate, *x509.CertPool, error) {
	pair, err := tls.X509KeyPair([]byte(certPEM), []byte(keyPEM))
	if err != nil {
		return nil, nil, err
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, nil, err
	}
	inter := x509.NewCertPool()
	for _, der := range pair.Certificate[1:] {
		if c, err := x509.ParseCertificate(der); err == nil {
			inter.AddCert(c)
		}
	}
	return leaf, inter, nil
}

// lbPrevious returns the node's previous certificate when its key matches
// (so Traefik can load it), else nil. It goes after the current one in a
// serversTransport: a TLS client presents the first certificate whose
// issuer the peer asks for. Its time is not checked, so the output does
// not change by itself: a peer that knows the current certificate never
// asks for an expired one.
func lbPrevious(lb *agentv1.LoadBalancerTls) *tlsCertificate {
	if lb.GetPreviousCertPem() == "" || lb.GetPreviousKeyPem() == "" {
		return nil
	}
	if _, _, err := lbPair(lb.GetPreviousCertPem(), lb.GetPreviousKeyPem()); err != nil {
		return nil
	}
	return &tlsCertificate{CertFile: lb.GetPreviousCertPem(), KeyFile: lb.GetPreviousKeyPem()}
}

// chainCerts parses every CERTIFICATE block of a PEM text (bad ones are
// skipped).
func chainCerts(text string) []*x509.Certificate {
	var out []*x509.Certificate
	rest := []byte(text)
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			return out
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		if c, err := x509.ParseCertificate(block.Bytes); err == nil {
			out = append(out, c)
		}
	}
}

// lbIssuer returns the PEM of the first certificate in text when it is a
// CA certificate the LB CA signed (and not the LB CA itself), re-encoded
// so nothing else in the text reaches the client CAs.
func lbIssuer(text string, ca *x509.Certificate) (string, bool) {
	certs := chainCerts(text)
	if len(certs) == 0 {
		return "", false
	}
	c := certs[0]
	if !c.BasicConstraintsValid || !c.IsCA || bytes.Equal(c.Raw, ca.Raw) || c.CheckSignatureFrom(ca) != nil {
		return "", false
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.Raw})), true
}

// lbClientCAs returns the client CAs of the LB entry point: the issuers of
// the current nodes' certificates (this node's own included), or the LB CA
// when the panel lists no peers (older panels), when a peer may still hold
// a certificate issued straight by the CA, or when no issuer is usable.
func lbClientCAs(lb *agentv1.LoadBalancerTls) []string {
	all := []string{lb.GetCaPem()}
	if len(lb.GetPeers()) == 0 {
		return all
	}
	cas := chainCerts(lb.GetCaPem())
	if len(cas) == 0 {
		return all
	}
	ca := cas[0]
	var out []string
	seen := map[string]bool{}
	add := func(text string) {
		if pemText, ok := lbIssuer(text, ca); ok && !seen[pemText] {
			seen[pemText] = true
			out = append(out, pemText)
		}
	}
	if own := chainCerts(lb.GetCertPem()); len(own) > 1 {
		add(string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: own[1].Raw})))
	}
	for _, p := range lb.GetPeers() {
		if p.GetLegacy() {
			return all
		}
		for _, text := range p.GetIssuerPems() {
			add(text)
		}
	}
	if len(out) == 0 {
		return all
	}
	return out
}

// BuildLBTLS renders LBTLSFile: the TLS options that require a client
// certificate a current node was issued, this node's certificate, and the
// anchor router for the server names.
func BuildLBTLS(lb *agentv1.LoadBalancerTls) ([]byte, error) {
	if lb == nil {
		return nil, fmt.Errorf("%w: missing", ErrBadLBTLS)
	}
	if err := checkLBTLS(lb); err != nil {
		return nil, err
	}
	hosts := make([]string, 0, 2)
	for _, name := range lbNames(lb) {
		hosts = append(hosts, fmt.Sprintf("Host(`%s`)", name))
	}
	anchor := LBTLSOptions + "-anchor"
	cfg := &dynamicConfig{
		HTTP: &httpConfig{
			Routers: map[string]*router{anchor: {
				EntryPoints: []string{EntryPointLB},
				Rule:        strings.Join(hosts, " || "),
				Service:     anchor,
				TLS:         &routerTLS{Options: LBTLSOptions},
			}},
			Services: map[string]*service{anchor: {LoadBalancer: &loadBalancer{Servers: []lbServer{}}}},
		},
		TLS: &tlsConfig{
			Certificates: []tlsCertificate{{CertFile: lb.GetCertPem(), KeyFile: lb.GetKeyPem()}},
			Options: map[string]*tlsOption{LBTLSOptions: {
				MinVersion: "VersionTLS12",
				ClientAuth: &clientAuth{CAFiles: lbClientCAs(lb), ClientAuthType: "RequireAndVerifyClientCert"},
			}},
		},
	}
	return render(cfg, fmt.Sprintf("# Written by the %s agent: mutual TLS between nodes on the LB entry point. Rewritten on every change; do not edit.\n", brand.DisplayName))
}

// lbPeerName returns the name to verify a copy on nodeID by, and false
// when the panel lists peers but not this node: it holds no certificate
// the panel stands behind, so it is not dialed. From older panels (no
// peers) every node goes by the shared server name.
func lbPeerName(lb *agentv1.LoadBalancerTls, nodeID string) (string, bool) {
	if len(lb.GetPeers()) == 0 {
		return lb.GetServerName(), true
	}
	for _, p := range lb.GetPeers() {
		if p.GetNodeId() != nodeID {
			continue
		}
		if name := p.GetServerName(); name != "" && checkHost(name) == nil {
			return name, true
		}
		return lb.GetServerName(), true
	}
	return "", false
}

// lbTransport is the serversTransport towards the copy on nodeID, and
// false when that copy must be left out (lbPeerName).
func lbTransport(lb *agentv1.LoadBalancerTls, nodeID string) (*serversTransport, bool) {
	if lb == nil {
		// Other nodes answer with Traefik's default certificate and take
		// any client: encrypted, not verified (older panels).
		return &serversTransport{InsecureSkipVerify: true}, true
	}
	name, ok := lbPeerName(lb, nodeID)
	if !ok {
		return nil, false
	}
	certs := []tlsCertificate{{CertFile: lb.GetCertPem(), KeyFile: lb.GetKeyPem()}}
	if prev := lbPrevious(lb); prev != nil {
		certs = append(certs, *prev)
	}
	return &serversTransport{ServerName: name, RootCAs: []string{lb.GetCaPem()}, Certificates: certs}, true
}

// nodeKey is a node id as it can go into a Traefik name: itself when it is
// a plain id, else a hash of it.
func nodeKey(nodeID string) string {
	if idPattern.MatchString(nodeID) {
		return nodeID
	}
	sum := sha256.Sum256([]byte(nodeID))
	return "x" + hex.EncodeToString(sum[:])[:12]
}
