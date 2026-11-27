//go:build !windows

package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/seylo-dev/app/go/internal/agent"
	"github.com/seylo-dev/app/go/internal/geoip"
	"github.com/seylo-dev/app/go/internal/systemd"
	"github.com/seylo-dev/app/go/internal/version"
)

// newGeoIPCommand is `seylo geoip`: the visitor country lookup behind the
// X-Seylo-Country header. `serve` is what the agent's systemd unit runs.
func newGeoIPCommand(d *deps) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "geoip",
		Short:   "The visitor country lookup behind the " + geoip.Header + " header",
		GroupID: groupNode,
	}
	cmd.AddCommand(newGeoIPServeCommand(d), newGeoIPLookupCommand(d), newGeoIPStatusCommand(d))
	return cmd
}

func geoipDBPath(d *deps) string {
	return filepath.Join(d.layout.Root(), "geoip", "country.mmdb")
}

func newGeoIPServeCommand(d *deps) *cobra.Command {
	var dbPath, listen string
	cmd := &cobra.Command{
		Use:    "serve",
		Short:  "Answer Traefik's country lookups (run by the " + geoip.ServiceUnit + " unit)",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if dbPath == "" {
				dbPath = geoipDBPath(d)
			}
			l, err := geoip.Listener(listen)
			if err != nil {
				return err
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
			defer stop()
			s := &geoip.Server{Path: dbPath, Version: version.Version, Logger: d.logger.With("component", "geoip")}
			d.logger.Info("country lookup listening", "addr", l.Addr().String(), "db", dbPath)
			return s.Serve(ctx, l)
		},
	}
	cmd.Flags().StringVar(&dbPath, "db", "", "country database (default: <data dir>/geoip/country.mmdb)")
	cmd.Flags().StringVar(&listen, "listen", "", "address to listen on when systemd passes no socket")
	return cmd
}

func newGeoIPLookupCommand(d *deps) *cobra.Command {
	var dbPath string
	cmd := &cobra.Command{
		Use:   "lookup <ip>...",
		Short: "Print the country of IP addresses from this node's database",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if dbPath == "" {
				dbPath = geoipDBPath(d)
			}
			data, err := os.ReadFile(dbPath)
			if errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("no country database at %s yet (the agent downloads it while the visitor country header is on)", dbPath)
			}
			if err != nil {
				return err
			}
			db, err := geoip.Open(data)
			if err != nil {
				return err
			}
			for _, a := range args {
				ip, err := netip.ParseAddr(a)
				if err != nil {
					return fmt.Errorf("%q is not an IP address", a)
				}
				fmt.Fprintf(d.out, "%s\t%s\n", ip, db.Country(ip))
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&dbPath, "db", "", "country database (default: <data dir>/geoip/country.mmdb)")
	return cmd
}

var socketListen = regexp.MustCompile(`(?m)^ListenStream=(\S+)$`)

func newGeoIPStatusCommand(d *deps) *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show the country header's database and lookup server on this node",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			tw := tabwriter.NewWriter(d.out, 0, 4, 2, ' ', 0)
			defer tw.Flush()
			on := agent.StoredSettings(d.layout).GetCountryHeader().GetEnabled()
			fmt.Fprintf(tw, "Header\t%s\n", map[bool]string{true: "on (" + geoip.Header + ")", false: "off"}[on])
			f := &geoip.Fetcher{Dir: filepath.Dir(geoipDBPath(d))}
			st, err := f.State()
			switch {
			case err != nil:
				fmt.Fprintf(tw, "Database\t%v\n", err)
			case st.Source == "":
				fmt.Fprintf(tw, "Database\tnone yet\n")
			default:
				src := "DB-IP IP to Country Lite " + st.Month
				if st.Source == geoip.SourceMaxMind {
					src = "MaxMind GeoLite2 Country"
				}
				fmt.Fprintf(tw, "Database\t%s, built %s, installed %s\n", src, st.Built.Format(time.DateOnly), st.InstalledAt.Local().Format(time.DateTime))
			}
			if st.LastError != "" {
				fmt.Fprintf(tw, "Last download\tfailed %s: %s\n", st.LastErrorAt.Local().Format(time.DateTime), st.LastError)
			}
			fmt.Fprintf(tw, "Server\t%s\n", geoipServerState(cmd.Context()))
			fmt.Fprintf(tw, "Credit\t%s\n", geoip.Attribution)
			return nil
		},
	}
}

// geoipServerState asks the server on the address its socket unit names.
func geoipServerState(ctx context.Context) string {
	data, err := os.ReadFile(filepath.Join(systemd.UnitDir, geoip.SocketUnit))
	if err != nil {
		return "not installed"
	}
	m := socketListen.FindSubmatch(data)
	if m == nil {
		return "the socket unit names no address"
	}
	listen := string(m[1])
	if _, _, err := net.SplitHostPort(listen); err != nil {
		listen = net.JoinHostPort(listen, strconv.Itoa(geoip.DefaultPort))
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+listen+geoip.HealthPath, nil)
	resp, err := (&http.Client{Transport: &http.Transport{Proxy: nil}}).Do(req)
	if err != nil {
		return fmt.Sprintf("not answering on %s: %v", listen, err)
	}
	defer resp.Body.Close()
	var h geoip.Health
	if err := json.NewDecoder(resp.Body).Decode(&h); err != nil {
		return fmt.Sprintf("answering on %s, unreadable health: %v", listen, err)
	}
	db := "no database loaded"
	if h.Database != nil {
		db = h.Database.Type + " built " + h.Database.Built.Format(time.DateOnly)
	}
	if h.Error != "" {
		db += " (newest file did not load: " + h.Error + ")"
	}
	return fmt.Sprintf("answering on %s, version %s, %s", listen, h.Version, db)
}
