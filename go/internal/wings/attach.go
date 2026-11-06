package wings

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/seylo-dev/app/go/internal/proxy"
)

// Attacher keeps the Wings fork's Traefik on our edge network: Wings
// recreates that container on upgrades and config changes, which drops the
// network we attached, so every start is followed by a re-attach.
type Attacher struct {
	Docker    proxy.Docker
	Container string
	// Network is the edge network (where the edge listener is reached).
	Network string
	// Extra returns more networks to keep attached: the project networks
	// of routed services (reconcile attaches them once; a recreated
	// container lost them).
	Extra func() []string
	// OnAttached gets Traefik's address on the edge network after each
	// attach (the router probes through it).
	OnAttached func(ip string)
	Logger     *slog.Logger
}

// Attach connects the container now. A missing container is not an error
// (Wings creates it later; Run catches the start).
func (a *Attacher) Attach(ctx context.Context) error {
	info, err := a.Docker.InspectContainer(ctx, a.Container)
	if errors.Is(err, proxy.ErrContainerNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, ok := info.IPs[a.Network]; !ok {
		if err := a.Docker.ConnectNetwork(ctx, a.Network, a.Container); err != nil {
			return err
		}
		if info, err = a.Docker.InspectContainer(ctx, a.Container); err != nil {
			return err
		}
		a.log().Info("attached Traefik to the edge network", "container", a.Container, "network", a.Network)
	}
	if a.Extra != nil {
		for _, n := range a.Extra() {
			if _, ok := info.IPs[n]; ok {
				continue
			}
			if err := a.Docker.ConnectNetwork(ctx, n, a.Container); err != nil {
				// The network may not exist yet; reconcile attaches it
				// when it routes there.
				a.log().Debug("attaching Traefik to a project network", "network", n, "err", err)
			}
		}
	}
	if ip := info.IPs[a.Network]; ip != "" && a.OnAttached != nil {
		a.OnAttached(ip)
	}
	return nil
}

func (a *Attacher) log() *slog.Logger {
	if a.Logger == nil {
		return slog.New(slog.DiscardHandler)
	}
	return a.Logger
}

// Run attaches now and after every start of the container until ctx ends.
// An event stream error is returned so the component restarts it.
func (a *Attacher) Run(ctx context.Context) error {
	events, errs := a.Docker.ContainerEvents(ctx, a.Container)
	if err := a.Attach(ctx); err != nil {
		a.log().Warn("attaching the Wings Traefik", "err", err)
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-errs:
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("docker events: %w", err)
		case action, ok := <-events:
			if !ok {
				return ctx.Err()
			}
			if action == "start" {
				if err := a.Attach(ctx); err != nil {
					a.log().Warn("re-attaching the Wings Traefik", "err", err)
				}
			}
		}
	}
}
