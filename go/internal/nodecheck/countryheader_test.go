package nodecheck

import (
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/geoip"
)

func TestJudgeCountryHeader(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	fresh := &geoip.DBInfo{Type: "DBIP-Country-Lite", Built: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)}
	old := &geoip.DBInfo{Type: "DBIP-Country-Lite", Built: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)}
	dbip := geoip.State{Source: geoip.SourceDBIP, Month: "2026-11"}
	cases := []struct {
		name   string
		r      *geoip.Report
		status agentv1.NodeCheckStatus
		has    string
	}{
		{"off", &geoip.Report{}, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_SKIPPED, "off"},
		{"nil", nil, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_SKIPPED, "off"},
		{"not answering", &geoip.Report{Enabled: true, Listen: "172.30.0.1:5758", HealthErr: "connection refused"}, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL, "does not answer"},
		{"no database", &geoip.Report{Enabled: true, Listen: "172.30.0.1:5758", Asked: true, State: geoip.State{LastError: "DB-IP 2026-11: timeout"}},
			agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN, "X-Seylo-Country: XX; the last download failed: DB-IP 2026-11: timeout"},
		{"old database", &geoip.Report{Enabled: true, Listen: "172.30.0.1:5758", Asked: true, Health: geoip.Health{Database: old}, State: dbip},
			agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN, "more than two months ago"},
		{"working", &geoip.Report{Enabled: true, Listen: "172.30.0.1:5758", Asked: true, Health: geoip.Health{Database: fresh}, State: dbip},
			agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS, "apps get X-Seylo-Country from DB-IP IP to Country Lite 2026-11 built 2026-11-01"},
		{"Traefik cannot reach it", &geoip.Report{Enabled: true, Listen: "172.30.0.1:5758", Health: geoip.Health{Database: fresh}, Unreachable: "download timed out"},
			agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL, "Traefik cannot reach the country lookup server on 172.30.0.1:5758 (download timed out)"},
		{"answering, files not yet", &geoip.Report{Enabled: true, Listen: "172.30.0.1:5758", Health: geoip.Health{Database: fresh}, State: dbip},
			agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS, "within seconds"},
	}
	for _, c := range cases {
		got := judgeCountryHeader(c.r, now)
		if got.GetStatus() != c.status || !strings.Contains(got.GetDetail(), c.has) {
			t.Errorf("%s: %s %q, want %s with %q", c.name, got.GetStatus(), got.GetDetail(), c.status, c.has)
		}
	}
}
