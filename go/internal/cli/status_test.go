package cli

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/localapi"
)

// A service whose route file the agent cannot write shows under Recent
// errors, after the last connection errors and whatever their number:
// before, only the agent's journal had it.
func TestStatusPrintsRouteWriteErrors(t *testing.T) {
	var out bytes.Buffer
	at := time.Date(2026, 11, 12, 9, 30, 0, 0, time.Local)
	var recent []localapi.ErrorEntry
	for i := range 7 {
		recent = append(recent, localapi.ErrorEntry{At: at.Add(time.Duration(i) * time.Minute), Source: "connection", Message: "dial panel: refused"})
	}
	s := localapi.NodeStatus{
		NodeName: "node-1", Connection: localapi.ConnectionStatus{State: "connected"}, RecentErrors: recent,
		RouteErrors: []localapi.ErrorEntry{{At: at, Source: "routes of web", Message: "invalid route: the host belongs to another service: shop.example.com"}},
	}
	if err := printNodeStatus(&deps{out: &out}, s); err != nil {
		t.Fatal(err)
	}
	text := out.String()
	if !strings.Contains(text, "Recent errors:\n") ||
		!strings.Contains(text, "  09:30:00  routes of web: invalid route: the host belongs to another service: shop.example.com (still failing)\n") {
		t.Fatalf("status:\n%s", text)
	}
	if n := strings.Count(text, "connection: dial panel: refused"); n != 5 {
		t.Fatalf("%d connection errors, want the last 5:\n%s", n, text)
	}

	out.Reset()
	s.RecentErrors = nil
	if err := printNodeStatus(&deps{out: &out}, s); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Recent errors:\n  09:30:00  routes of web: ") {
		t.Fatalf("route errors alone:\n%s", out.String())
	}
}
