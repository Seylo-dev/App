package tailnet

import (
	"slices"
	"strconv"
	"strings"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Backend states the agent acts on (ipn.State names).
const (
	StateNeedsLogin       = "NeedsLogin"
	StateNeedsMachineAuth = "NeedsMachineAuth"
	StateStopped          = "Stopped"
	StateRunning          = "Running"
)

// Info is TailscaleInfo for a status and prefs read together, without the
// Serve status and disabled_on_server, which the Manager adds. prefs may
// be nil (they could not be read).
func Info(st *Status, prefs *Prefs) *agentv1.TailscaleInfo {
	info := &agentv1.TailscaleInfo{
		Version:      ShortVersion(st.Version),
		BackendState: st.BackendState,
		Addresses:    slices.Clone(st.TailscaleIPs),
		Https:        len(st.CertDomains) > 0,
	}
	if t := st.CurrentTailnet; t != nil {
		info.Tailnet = t.Name
		info.MagicDns = t.MagicDNSEnabled
	}
	info.ExitNodeInUse = st.ExitNodeStatus != nil
	if self := st.Self; self != nil {
		info.DnsName = strings.TrimSuffix(self.DNSName, ".")
		info.Tags = slices.Clone(self.Tags)
		if self.KeyExpiry != nil && !self.KeyExpiry.IsZero() {
			info.KeyExpiry = timestamppb.New(*self.KeyExpiry)
		}
		if len(self.Tags) == 0 {
			info.LoginName = st.User[strconv.FormatInt(self.UserID, 10)].LoginName
		}
	}
	if prefs != nil {
		info.AcceptDns = prefs.CorpDNS
		info.AdvertisesRoutes = len(prefs.AdvertiseRoutes) > 0
		if prefs.ExitNodeID != "" || prefs.ExitNodeIP != "" {
			info.ExitNodeInUse = true
		}
	}
	return info
}
