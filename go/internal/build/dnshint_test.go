package build

import (
	"context"
	"fmt"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// realNodeBuildKitError is how every build failed on a node whose Docker
// gave containers no DNS server (daemon.json "dns" entries that are not
// addresses, so the build worker's resolv.conf said "nameserver invalid
// IP" and BuildKit fell back to [::1]:53).
const realNodeBuildKitError = `#1 [internal] load build definition from Dockerfile
#1 DONE 0.0s

#2 [internal] load metadata for docker.io/library/node:22
#2 ERROR: failed to do request: Head "https://registry-1.docker.io/v2/library/node/manifests/22": dial tcp: lookup registry-1.docker.io on [::1]:53: read udp [::1]:41263->[::1]:53: read: connection refused
------
 > [internal] load metadata for docker.io/library/node:22:
------
ERROR: failed to build: failed to solve: node:22: failed to resolve source metadata for docker.io/library/node:22: failed to do request: Head "https://registry-1.docker.io/v2/library/node/manifests/22": dial tcp: lookup registry-1.docker.io on [::1]:53: read udp [::1]:41263->[::1]:53: read: connection refused
`

// A build that failed on a name lookup in the build worker says, after the
// failure, which node check explains it; other failures do not.
func TestBuildLogPointsAtContainerDNS(t *testing.T) {
	fr := &fakeRunner{}
	fr.build = func(_ context.Context, c Cmd) error {
		// The request's tag tells the two builds apart.
		if strings.Contains(strings.Join(c.Args, " "), ":dns ") {
			fmt.Fprint(c.Stdout, realNodeBuildKitError)
		} else {
			fmt.Fprint(c.Stdout, "#5 ERROR: process \"/bin/sh -c npm ci\" did not complete successfully: exit code: 1\n")
		}
		return &ExitError{Cmd: "docker", Code: 1}
	}
	rep := newReports()
	svc := newTestService(t, fr, rep)
	build := func(id, tag string) (*agentv1.BuildProgress, string) {
		t.Helper()
		req := inlineRequest(id)
		req.ImageReference = DefaultRegistry + "/svc1:" + tag
		job, err := svc.Start(req)
		if err != nil {
			t.Fatal(err)
		}
		p := finalOf(t, rep)
		var log strings.Builder
		_ = job.Watch(context.Background(), func(r *agentv1.BuildResponse) error { log.Write(r.GetLog()); return nil })
		return p, log.String()
	}
	p, log := build("b1", "dns")
	if p.GetStage() != agentv1.BuildStage_BUILD_STAGE_FAILED || p.GetMessage() != "The build failed - the lines above say why" {
		t.Fatalf("final %v %q", p.GetStage(), p.GetMessage())
	}
	if want := "\n--> The build failed - the lines above say why\n--> " + DNSHint + "\n"; !strings.HasSuffix(log, want) {
		t.Fatalf("log does not end with %q:\n%s", want, log)
	}
	if _, log := build("b2", "other"); strings.Contains(log, DNSHint) || !strings.HasSuffix(log, "the lines above say why\n") {
		t.Fatalf("a failure without a lookup error got the DNS hint:\n%s", log)
	}
}

func TestFailureHint(t *testing.T) {
	exit := &ExitError{Cmd: "docker", Code: 1}
	for out, want := range map[string]bool{
		realNodeBuildKitError: true,
		"ERROR: failed to solve: ghcr.io/o/a:1: failed to resolve source metadata: lookup ghcr.io on 127.0.0.11:53: server misbehaving": true,
		"failed to do request: Head \"https://registry.invalid/v2/a/manifests/1\": dial tcp: lookup registry.invalid: no such host":     true,
		"W: Failed to fetch http://deb.debian.org/debian/dists/bookworm/InRelease  Temporary failure resolving 'deb.debian.org'":        true,
		"curl: (6) Could not resolve host: example.com":                                                                     true,
		"NewConnectionError: Failed to establish a new connection: [Errno -3] Temporary failure in name resolution":         true,
		"npm error request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org": true,
		"npm error 404 Not Found - GET https://registry.npmjs.org/left-pad-typo":                                            false,
		"ERROR: failed to solve: process \"/bin/sh -c exit 1\" did not complete successfully: exit code: 1":                 false,
		"error: lookup table is full": false,
	} {
		if got := failureHint(exit, out) != ""; got != want {
			t.Errorf("hint for %q = %v, want %v", out, got, want)
		}
	}
	// Only a builder that failed: not a success, a cancel, a timeout or a
	// fetch error that says what went wrong itself.
	for _, err := range []error{nil, context.Canceled, context.DeadlineExceeded, fmt.Errorf("%w: could not pull x", ErrFetch)} {
		if failureHint(err, realNodeBuildKitError) != "" {
			t.Errorf("hint for %v", err)
		}
	}
	if failureHint(fmt.Errorf("creating the build worker: %w", exit), realNodeBuildKitError) != DNSHint {
		t.Error("no hint when creating the build worker failed")
	}
}

// The hint reads the end of the output, where BuildKit puts the error: a
// lookup error long before does not count.
func TestJobRecentKeepsTheEnd(t *testing.T) {
	j := newJob("b1", "svc1", func() {})
	fmt.Fprint(j, "dial tcp: lookup registry-1.docker.io on [::1]:53: connection refused\n")
	if !strings.Contains(j.recent(), "lookup registry-1.docker.io") {
		t.Fatal("recent output lost")
	}
	line := strings.Repeat("x", 1023) + "\n"
	for range 3 * tailKeep / len(line) {
		fmt.Fprint(j, line)
	}
	fmt.Fprint(j, "the end\n")
	got := j.recent()
	if len(got) != tailKeep || !strings.HasSuffix(got, "the end\n") || strings.Contains(got, "lookup") {
		t.Fatalf("recent = %d bytes, ends %q", len(got), got[max(0, len(got)-20):])
	}
	if failureHint(&ExitError{Cmd: "docker", Code: 1}, got) != "" {
		t.Fatal("a lookup error 192 KiB before the end got the hint")
	}
}

// failureHint is the hints without secret ARGs, one per line.
func failureHint(err error, output string) string {
	return strings.Join(failureHints(err, output, nil), "\n")
}
