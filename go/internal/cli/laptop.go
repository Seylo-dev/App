package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/panelapi"
)

func newLoginCommand(d *deps) *cobra.Command {
	var opts panelapi.LoginOptions
	var tokenStdin, noBrowser bool
	cmd := &cobra.Command{
		Use:   "login <panel-url>",
		Short: "Sign in to a panel (approve in the browser, or with an API key)",
		Long: "Signs in to a panel and saves an API key in ~/.config/" + brand.Slug + "/config.json.\n" +
			"By default it opens the panel's approval page in your browser: check the code, pick\n" +
			"what the key may do and approve. With --token or --token-stdin it saves an API key\n" +
			"you created under Settings > API keys and MCP instead.",
		GroupID: groupLaptop,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			opts.PanelURL = args[0]
			switch {
			case tokenStdin:
				token, err := readSecret(d.in, false)
				if err != nil {
					return err
				}
				opts.Token = token
			case opts.Token == "":
				token, err := browserLogin(cmd, d, args[0], !noBrowser)
				if err != nil {
					return err
				}
				opts.Token = token
			}
			viewer, err := panelapi.Login(cmd.Context(), opts)
			if err != nil {
				return err
			}
			_, err = fmt.Fprintf(d.out, "Signed in to %s as %s (profile %q).\n", args[0], viewer.Email, profileName(opts.Profile))
			return err
		},
	}
	cmd.Flags().StringVar(&opts.Token, "token", "", "API key (default: approve the sign-in in the browser)")
	cmd.Flags().BoolVar(&tokenStdin, "token-stdin", false, "read the API key from standard input")
	cmd.Flags().BoolVar(&noBrowser, "no-browser", false, "print the approval link instead of opening a browser")
	cmd.Flags().StringVar(&opts.Profile, "profile", panelapi.DefaultProfile, "name for these saved credentials")
	return cmd
}

// browserLogin runs the browser approval: print the code and link, open
// the link, wait for the approval and return the new API key.
func browserLogin(cmd *cobra.Command, d *deps, panelURL string, open bool) (string, error) {
	c, start, err := panelapi.StartBrowserLogin(cmd.Context(), panelURL, panelapi.ClientName())
	if err != nil {
		return "", err
	}
	fmt.Fprintf(d.out, "Your sign-in code: %s\n", start.UserCode)
	fmt.Fprintf(d.out, "Approve it at %s\n", start.VerificationURL)
	if open && openBrowser(start.VerificationURL) == nil {
		fmt.Fprintln(d.out, "(opened in your browser)")
	}
	fmt.Fprintln(d.out, "Waiting for the approval...")
	ctx := cmd.Context()
	if !start.ExpiresAt.IsZero() {
		var cancel func()
		ctx, cancel = context.WithDeadline(ctx, start.ExpiresAt.Add(30*time.Second))
		defer cancel()
	}
	token, err := c.WaitBrowserLogin(ctx, start)
	if errors.Is(err, context.DeadlineExceeded) {
		return "", panelapi.ErrLoginExpired
	}
	return token, err
}

// openBrowser opens a URL with the desktop's default browser.
func openBrowser(u string) error {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		c = exec.Command("open", u)
	case "windows":
		c = exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	default:
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return errors.New("no desktop session")
		}
		c = exec.Command("xdg-open", u)
	}
	return c.Start()
}

func newLogoutCommand(d *deps) *cobra.Command {
	return &cobra.Command{
		Use:     "logout",
		Short:   "Forget the saved API key",
		GroupID: groupLaptop,
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := panelapi.Logout(d.profile); err != nil {
				return err
			}
			_, err := fmt.Fprintln(d.out, "Signed out.")
			return err
		},
	}
}

func profileName(p string) string {
	if p == "" {
		return panelapi.DefaultProfile
	}
	return p
}

// readSecret reads one line. On a terminal it turns echo off with stty so
// the key does not show on screen.
func readSecret(in io.Reader, prompt bool) (string, error) {
	if f, ok := in.(*os.File); ok && prompt && isTerminal(f) {
		if err := stty(f, "-echo"); err == nil {
			defer func() { _ = stty(f, "echo") }()
		}
	}
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return "", errors.New("no API key given")
	}
	return line, nil
}

func isTerminal(f *os.File) bool {
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func stty(f *os.File, arg string) error {
	cmd := exec.Command("stty", arg)
	cmd.Stdin = f
	return cmd.Run()
}

// client opens the saved panel login.
func (d *deps) client() (*panelapi.Client, error) {
	if d.openClient != nil {
		return d.openClient(d.profile)
	}
	return panelapi.Open(d.profile)
}

func newDeployCommand(d *deps) *cobra.Command {
	var opts panelapi.DeployOptions
	cmd := &cobra.Command{
		Use:     "deploy <project/service>",
		Short:   "Deploy a service from its configured source",
		GroupID: groupLaptop,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := d.client()
			if err != nil {
				return err
			}
			opts.Service = panelapi.ServiceRef(args[0])
			return c.Deploy(cmd.Context(), opts, d.out)
		},
	}
	cmd.Flags().BoolVar(&opts.Wait, "wait", true, "follow the deploy until it finishes")
	return cmd
}

func newEnvCommand(d *deps) *cobra.Command {
	env := &cobra.Command{
		Use:     "env",
		Short:   "Read and change a service's environment",
		GroupID: groupLaptop,
	}
	var noDeploy bool
	env.PersistentFlags().BoolVar(&noDeploy, "no-deploy", false, "change the variables without redeploying")

	report := func(res panelapi.EnvResult) {
		for _, w := range res.Warnings {
			fmt.Fprintln(d.out, "warning: "+w)
		}
		for _, k := range res.Missing {
			fmt.Fprintf(d.out, "%s was not set\n", k)
		}
		if res.Deployed != nil {
			fmt.Fprintf(d.out, "Saved. Deploying %s (deployment %s).\n", res.Service.Name, res.Deployed.ID)
		} else {
			fmt.Fprintln(d.out, "Saved. The new values apply on the next deploy.")
		}
	}

	env.AddCommand(
		&cobra.Command{
			Use:   "list <project/service>",
			Short: "Print the environment as a .env file",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				c, err := d.client()
				if err != nil {
					return err
				}
				doc, err := c.ListEnv(cmd.Context(), panelapi.ServiceRef(args[0]))
				if err != nil {
					return err
				}
				_, err = fmt.Fprint(d.out, doc)
				return err
			},
		},
		&cobra.Command{
			Use:   "set <project/service> KEY=VALUE...",
			Short: "Set variables",
			Args:  cobra.MinimumNArgs(2),
			RunE: func(cmd *cobra.Command, args []string) error {
				for _, a := range args[1:] {
					if !validAssignment(a) {
						return fmt.Errorf("%q is not KEY=VALUE", a)
					}
				}
				c, err := d.client()
				if err != nil {
					return err
				}
				res, err := c.SetEnv(cmd.Context(), panelapi.ServiceRef(args[0]), args[1:], noDeploy)
				if err != nil {
					return err
				}
				report(res)
				return nil
			},
		},
		&cobra.Command{
			Use:   "unset <project/service> KEY...",
			Short: "Remove variables",
			Args:  cobra.MinimumNArgs(2),
			RunE: func(cmd *cobra.Command, args []string) error {
				c, err := d.client()
				if err != nil {
					return err
				}
				res, err := c.UnsetEnv(cmd.Context(), panelapi.ServiceRef(args[0]), args[1:], noDeploy)
				if err != nil {
					return err
				}
				report(res)
				return nil
			},
		},
	)
	return env
}

func validAssignment(s string) bool {
	key, _, ok := strings.Cut(s, "=")
	return ok && key != ""
}

func newTunnelCommand(d *deps) *cobra.Command {
	tunnel := &cobra.Command{
		Use:     "tunnel",
		Short:   "Open temporary access to a service",
		GroupID: groupLaptop,
	}
	tunnel.AddCommand(newTunnelExposeCommand(d), newTunnelCloudflareCommand(d))
	return tunnel
}

func newTunnelExposeCommand(d *deps) *cobra.Command {
	var opts panelapi.ExposeOptions
	var port uint32
	cmd := &cobra.Command{
		Use:   "expose <project/service>",
		Short: "Open a service port to your IP for a limited time",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if port == 0 {
				return errors.New("--port is required")
			}
			if opts.For < 5*time.Minute || opts.For > 24*time.Hour {
				return errors.New("--for must be between 5m and 24h")
			}
			c, err := d.client()
			if err != nil {
				return err
			}
			opts.Service, opts.Port = panelapi.ServiceRef(args[0]), port
			exp, err := c.ExposeTimed(cmd.Context(), opts)
			if err != nil {
				return err
			}
			_, err = fmt.Fprintf(d.out, "Open until %s: %s:%d\n", exp.ExpiresAt, exp.Host, *exp.Port)
			return err
		},
	}
	cmd.Flags().Uint32Var(&port, "port", 0, "container port to expose")
	cmd.Flags().DurationVar(&opts.For, "for", time.Hour, "how long the port stays open (5m to 24h)")
	cmd.Flags().StringVar(&opts.FromCIDR, "from", "", "source address allowed in (default: your public IP)")
	return cmd
}

func newTunnelCloudflareCommand(d *deps) *cobra.Command {
	return &cobra.Command{
		Use:       "cloudflare <project/service> on|off",
		Short:     "Turn a service's Cloudflare tunnel on or off",
		Args:      cobra.ExactArgs(2),
		ValidArgs: []string{"on", "off"},
		RunE: func(cmd *cobra.Command, args []string) error {
			var enabled bool
			switch args[1] {
			case "on":
				enabled = true
			case "off":
			default:
				return fmt.Errorf("want on or off, got %q", args[1])
			}
			c, err := d.client()
			if err != nil {
				return err
			}
			t, err := c.SetCloudflareTunnel(cmd.Context(), panelapi.ServiceRef(args[0]), enabled)
			if err != nil {
				return err
			}
			if enabled && t.URL != nil {
				_, err = fmt.Fprintln(d.out, *t.URL)
				return err
			}
			_, err = fmt.Fprintf(d.out, "Tunnel %s.\n", args[1])
			return err
		},
	}
}
