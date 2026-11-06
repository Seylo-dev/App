// Traefik dynamic configuration types, only as much as Seylo writes. Keys
// are Traefik's own.
//
// Ported in part from the Wings fork's proxy/routes.go:
//
// MIT License
//
// Copyright (c) 2018 - 2021 Dane Everitt <dane@daneeveritt.com> and Contributors
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package proxy

import (
	"bytes"
	"fmt"

	"go.yaml.in/yaml/v3"
)

type dynamicConfig struct {
	HTTP *httpConfig `yaml:"http,omitempty"`
	TLS  *tlsConfig  `yaml:"tls,omitempty"`
}

type httpConfig struct {
	Routers           map[string]*router           `yaml:"routers,omitempty"`
	Middlewares       map[string]*middleware       `yaml:"middlewares,omitempty"`
	Services          map[string]*service          `yaml:"services,omitempty"`
	ServersTransports map[string]*serversTransport `yaml:"serversTransports,omitempty"`
}

type router struct {
	EntryPoints []string   `yaml:"entryPoints"`
	Rule        string     `yaml:"rule"`
	Priority    int        `yaml:"priority,omitempty"`
	Middlewares []string   `yaml:"middlewares,omitempty"`
	Service     string     `yaml:"service"`
	TLS         *routerTLS `yaml:"tls,omitempty"`
}

// routerTLS is `tls: {}` (default store, picks a matching certificate,
// including the file's custom ones) or `tls: {certResolver: le}`.
type routerTLS struct {
	CertResolver string `yaml:"certResolver,omitempty"`
	// Options names TLS options (LBTLSOptions on the LB entry point).
	Options string `yaml:"options,omitempty"`
}

type middleware struct {
	StripPrefix    *stripPrefix    `yaml:"stripPrefix,omitempty"`
	RedirectScheme *redirectScheme `yaml:"redirectScheme,omitempty"`
	RedirectRegex  *redirectRegex  `yaml:"redirectRegex,omitempty"`
	ReplacePath    *replacePath    `yaml:"replacePath,omitempty"`
	Errors         *errorPage      `yaml:"errors,omitempty"`
	BasicAuth      *basicAuth      `yaml:"basicAuth,omitempty"`
	IPAllowList    *ipAllowList    `yaml:"ipAllowList,omitempty"`
	RateLimit      *rateLimit      `yaml:"rateLimit,omitempty"`
	Headers        *headers        `yaml:"headers,omitempty"`
}

type stripPrefix struct {
	Prefixes []string `yaml:"prefixes"`
}

type redirectScheme struct {
	Scheme    string `yaml:"scheme"`
	Permanent bool   `yaml:"permanent"`
}

type redirectRegex struct {
	Regex       string `yaml:"regex"`
	Replacement string `yaml:"replacement"`
	Permanent   bool   `yaml:"permanent"`
}

type replacePath struct {
	Path string `yaml:"path"`
}

// errorPage replaces answers with one of these statuses by the page at
// Query on Service.
type errorPage struct {
	Status  []string `yaml:"status"`
	Service string   `yaml:"service"`
	Query   string   `yaml:"query"`
}

type basicAuth struct {
	// "user:bcrypt-hash" pairs, htpasswd style.
	Users []string `yaml:"users"`
	Realm string   `yaml:"realm,omitempty"`
}

type ipAllowList struct {
	SourceRange []string `yaml:"sourceRange"`
}

type rateLimit struct {
	Average uint32 `yaml:"average"`
	Burst   uint32 `yaml:"burst,omitempty"`
	Period  string `yaml:"period,omitempty"`
}

type headers struct {
	CustomRequestHeaders  map[string]string `yaml:"customRequestHeaders,omitempty"`
	CustomResponseHeaders map[string]string `yaml:"customResponseHeaders,omitempty"`
}

type service struct {
	LoadBalancer *loadBalancer `yaml:"loadBalancer,omitempty"`
	Failover     *failover     `yaml:"failover,omitempty"`
}

// failover sends a request to Fallback when Service answers one of
// Errors.Status (Traefik buffers up to MaxRequestBodyBytes to replay it).
type failover struct {
	Service  string          `yaml:"service"`
	Fallback string          `yaml:"fallback"`
	Errors   *failoverErrors `yaml:"errors,omitempty"`
}

type failoverErrors struct {
	Status              []string `yaml:"status"`
	MaxRequestBodyBytes int64    `yaml:"maxRequestBodyBytes"`
}

type loadBalancer struct {
	Servers          []lbServer `yaml:"servers"`
	Sticky           *sticky    `yaml:"sticky,omitempty"`
	ServersTransport string     `yaml:"serversTransport,omitempty"`
	PassHostHeader   *bool      `yaml:"passHostHeader,omitempty"`
}

type lbServer struct {
	URL string `yaml:"url"`
}

type sticky struct {
	Cookie *stickyCookie `yaml:"cookie"`
}

type stickyCookie struct {
	Name     string `yaml:"name"`
	Secure   bool   `yaml:"secure"`
	HTTPOnly bool   `yaml:"httpOnly"`
	SameSite string `yaml:"sameSite,omitempty"`
}

type serversTransport struct {
	InsecureSkipVerify bool `yaml:"insecureSkipVerify,omitempty"`
	// ServerName is sent as SNI and checked in the peer's certificate.
	ServerName string `yaml:"serverName,omitempty"`
	// RootCAs and Certificates take PEM content, like tlsCertificate.
	RootCAs      []string         `yaml:"rootCAs,omitempty"`
	Certificates []tlsCertificate `yaml:"certificates,omitempty"`
}

type tlsConfig struct {
	Certificates []tlsCertificate      `yaml:"certificates,omitempty"`
	Options      map[string]*tlsOption `yaml:"options,omitempty"`
}

type tlsOption struct {
	MinVersion string      `yaml:"minVersion,omitempty"`
	ClientAuth *clientAuth `yaml:"clientAuth,omitempty"`
}

// clientAuth takes PEM content in caFiles too.
type clientAuth struct {
	CAFiles        []string `yaml:"caFiles"`
	ClientAuthType string   `yaml:"clientAuthType"`
}

// tlsCertificate takes the PEM content itself (Traefik accepts a path or
// the content in certFile and keyFile).
type tlsCertificate struct {
	CertFile string `yaml:"certFile"`
	KeyFile  string `yaml:"keyFile"`
}

// render encodes cfg as YAML after a comment header. Map keys are sorted
// by the encoder, so the output is deterministic.
func render(cfg *dynamicConfig, header string) ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteString(header)
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(cfg); err != nil {
		return nil, fmt.Errorf("encoding route file: %w", err)
	}
	if err := enc.Close(); err != nil {
		return nil, fmt.Errorf("encoding route file: %w", err)
	}
	return buf.Bytes(), nil
}
