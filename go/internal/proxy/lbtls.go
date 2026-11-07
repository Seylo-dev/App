package proxy

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"

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
//     present a certificate from the panel's LB CA. An anchor router for
//     the certificates' server name makes that SNI pick the same options,
//     so Traefik's SNI/Host check (421) also refuses a client that sends
//     no SNI or another one;
//   - the balancing node verifies the peer against the CA by server name
//     and presents its own certificate (serversTransport).
//
// Without lb_tls (a node whose certificate the panel could not issue yet)
// no router uses the LB entry point: it answers 404 to everyone instead of
// taking any client (routes.go, lbRouters).

// LBTLSOptions names the TLS options of the LB routers.
const LBTLSOptions = brand.Slug + "-lb"

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

// checkLBTLS makes sure the CA parses, the key matches the certificate and
// the certificate is valid for server_name under that CA, for both server
// and client auth.
func checkLBTLS(lb *agentv1.LoadBalancerTls) error {
	if err := checkHost(lb.GetServerName()); err != nil {
		return fmt.Errorf("%w: server name: %w", ErrBadLBTLS, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(lb.GetCaPem())) {
		return fmt.Errorf("%w: no CA certificate", ErrBadLBTLS)
	}
	pair, err := tls.X509KeyPair([]byte(lb.GetCertPem()), []byte(lb.GetKeyPem()))
	if err != nil {
		return fmt.Errorf("%w: %w", ErrBadLBTLS, err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return fmt.Errorf("%w: %w", ErrBadLBTLS, err)
	}
	inter := x509.NewCertPool()
	for _, der := range pair.Certificate[1:] {
		if c, err := x509.ParseCertificate(der); err == nil {
			inter.AddCert(c)
		}
	}
	for _, usage := range []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth} {
		if _, err := leaf.Verify(x509.VerifyOptions{DNSName: lb.GetServerName(), Roots: pool, Intermediates: inter, KeyUsages: []x509.ExtKeyUsage{usage}}); err != nil {
			return fmt.Errorf("%w: %w", ErrBadLBTLS, err)
		}
	}
	return nil
}

// BuildLBTLS renders LBTLSFile: the TLS options that require a client
// certificate from the CA, this node's certificate, and the anchor router
// for the server name.
func BuildLBTLS(lb *agentv1.LoadBalancerTls) ([]byte, error) {
	if lb == nil {
		return nil, fmt.Errorf("%w: missing", ErrBadLBTLS)
	}
	if err := checkLBTLS(lb); err != nil {
		return nil, err
	}
	anchor := LBTLSOptions + "-anchor"
	cfg := &dynamicConfig{
		HTTP: &httpConfig{
			Routers: map[string]*router{anchor: {
				EntryPoints: []string{EntryPointLB},
				Rule:        fmt.Sprintf("Host(`%s`)", lb.GetServerName()),
				Service:     anchor,
				TLS:         &routerTLS{Options: LBTLSOptions},
			}},
			Services: map[string]*service{anchor: {LoadBalancer: &loadBalancer{Servers: []lbServer{}}}},
		},
		TLS: &tlsConfig{
			Certificates: []tlsCertificate{{CertFile: lb.GetCertPem(), KeyFile: lb.GetKeyPem()}},
			Options: map[string]*tlsOption{LBTLSOptions: {
				MinVersion: "VersionTLS12",
				ClientAuth: &clientAuth{CAFiles: []string{lb.GetCaPem()}, ClientAuthType: "RequireAndVerifyClientCert"},
			}},
		},
	}
	return render(cfg, fmt.Sprintf("# Written by the %s agent: mutual TLS between nodes on the LB entry point. Rewritten on every change; do not edit.\n", brand.DisplayName))
}

// lbTransport is the serversTransport towards copies on other nodes.
func lbTransport(lb *agentv1.LoadBalancerTls) *serversTransport {
	if lb == nil {
		// Other nodes answer with Traefik's default certificate and take
		// any client: encrypted, not verified (older panels).
		return &serversTransport{InsecureSkipVerify: true}
	}
	return &serversTransport{
		ServerName:   lb.GetServerName(),
		RootCAs:      []string{lb.GetCaPem()},
		Certificates: []tlsCertificate{{CertFile: lb.GetCertPem(), KeyFile: lb.GetKeyPem()}},
	}
}
