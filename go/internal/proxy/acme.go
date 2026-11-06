package proxy

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// acmeStore reads the certificates Traefik keeps in acme.json, cached by
// modification time. In shared Wings mode this is the fork's acme.json.
type acmeStore struct {
	path string

	mu    sync.Mutex
	mtime time.Time
	certs []acmeCert
}

type acmeCert struct {
	Domain struct {
		Main string   `json:"main"`
		SANs []string `json:"sans"`
	} `json:"domain"`
	Certificate string `json:"certificate"`
	Key         string `json:"key"`
}

type acmeResolver struct {
	Certificates []acmeCert `json:"Certificates"`
}

func (s *acmeStore) load() ([]acmeCert, error) {
	if s == nil || s.path == "" {
		return nil, nil
	}
	st, err := os.Stat(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading acme.json: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if st.ModTime().Equal(s.mtime) && s.certs != nil {
		return s.certs, nil
	}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return nil, fmt.Errorf("reading acme.json: %w", err)
	}
	certs, err := parseAcme(raw)
	if err != nil {
		return nil, err
	}
	s.mtime, s.certs = st.ModTime(), certs
	return certs, nil
}

// parseAcme reads every resolver's certificates from Traefik's acme.json.
func parseAcme(raw []byte) ([]acmeCert, error) {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return []acmeCert{}, nil
	}
	var resolvers map[string]*acmeResolver
	if err := json.Unmarshal(raw, &resolvers); err != nil {
		return nil, fmt.Errorf("parsing acme.json: %w", err)
	}
	out := []acmeCert{}
	for _, r := range resolvers {
		if r != nil {
			out = append(out, r.Certificates...)
		}
	}
	return out, nil
}

func (c acmeCert) covers(host string) bool {
	if strings.EqualFold(c.Domain.Main, host) {
		return true
	}
	for _, san := range c.Domain.SANs {
		if strings.EqualFold(san, host) {
			return true
		}
	}
	return false
}

// has reports whether Traefik holds a certificate for host.
func (s *acmeStore) has(host string) bool {
	certs, err := s.load()
	if err != nil {
		return false
	}
	for _, c := range certs {
		if c.covers(host) {
			return true
		}
	}
	return false
}

// info returns the issuer and expiry of host's certificate; ok is false
// when Traefik holds none (or it does not parse).
func (s *acmeStore) info(host string) (certInfo, bool) {
	cert, _, err := s.Certificate(host)
	if err != nil {
		return certInfo{}, false
	}
	info, err := leafInfo(cert)
	if err != nil {
		return certInfo{}, false
	}
	return info, true
}

// Certificate returns the PEM chain and key Traefik obtained for host.
func (s *acmeStore) Certificate(host string) ([]byte, []byte, error) {
	certs, err := s.load()
	if err != nil {
		return nil, nil, err
	}
	for _, c := range certs {
		if !c.covers(host) {
			continue
		}
		cert, err1 := base64.StdEncoding.DecodeString(c.Certificate)
		key, err2 := base64.StdEncoding.DecodeString(c.Key)
		if err1 != nil || err2 != nil {
			return nil, nil, fmt.Errorf("decoding certificate for %s from acme.json", host)
		}
		return cert, key, nil
	}
	return nil, nil, fmt.Errorf("%w: %s", ErrNoCertificate, host)
}
