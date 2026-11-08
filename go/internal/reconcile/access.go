package reconcile

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/crash"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/health"
	"github.com/seylo-dev/app/go/internal/proxy"
)

// syncAccess points routes and the Cloudflare tunnel at the running
// instances (none: routes serve the status page). IP:port listeners are
// the portgate's: it follows the desired state and asks Resolve for the
// target of each connection.
func (w *worker) syncAccess(ctx context.Context, spec *agentv1.ServiceSpec, live []liveInstance) {
	live = w.routable(live)
	if err := w.syncRoutes(ctx, spec, live, false); err != nil {
		w.log.Warn("writing routes", "err", err)
		w.retryLater(10 * time.Second)
	}
	w.syncTunnel(ctx, spec, live)
}

// routable drops unhealthy instances from the route while another one is
// not unhealthy. When none is healthy they all stay: a single replica keeps
// serving what it can and the service shows DEGRADED.
func (w *worker) routable(live []liveInstance) []liveInstance {
	ok := make([]liveInstance, 0, len(live))
	for _, l := range live {
		if wt := w.watches[l.id]; wt == nil || wt.State() != agentv1.HealthState_HEALTH_STATE_UNHEALTHY {
			ok = append(ok, l)
		}
	}
	if len(ok) == 0 {
		return live
	}
	return ok
}

// routePort is the container port local upstreams point at: the first
// route's target, else the first TCP port.
func routePort(spec *agentv1.ServiceSpec) uint32 {
	for _, r := range spec.GetRouting().GetRoutes() {
		if r.GetTargetPort() != 0 {
			return r.GetTargetPort()
		}
	}
	return health.FirstTCPPort(spec.GetPorts())
}

// Upstreams returns the local upstream URLs of live instances, by
// container name (Traefik shares the project network).
func upstreams(spec *agentv1.ServiceSpec, live []liveInstance) []proxy.Upstream {
	port := routePort(spec)
	if port == 0 {
		return nil
	}
	out := make([]proxy.Upstream, 0, len(live))
	for _, l := range live {
		out = append(out, proxy.Upstream{URL: "http://" + net.JoinHostPort(l.name, strconv.Itoa(int(port)))})
	}
	return out
}

func keyOf(parts ...any) string {
	h := sha256.New()
	for _, p := range parts {
		switch v := p.(type) {
		case proto.Message:
			b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(v)
			h.Write(b)
		default:
			fmt.Fprintf(h, "%v", v)
		}
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil)[:12])
}

// syncRoutes writes the route file when the routes or upstreams changed
// (always when force is set: a deploy switches on purpose).
func (w *worker) syncRoutes(ctx context.Context, spec *agentv1.ServiceSpec, live []liveInstance, force bool) error {
	rt := w.r.o.Router
	if rt == nil {
		return nil
	}
	ups := upstreams(spec, live)
	if spec.GetStopped() || w.rec.Sleeping {
		ups = nil
	}
	routed := len(spec.GetRouting().GetRoutes()) > 0
	if routed && len(ups) > 0 {
		w.r.attachProxy(ctx, spec.GetProjectId())
	}
	key := keyOf(spec.GetRouting(), spec.GetLoadBalancer(), spec.GetStopped(), w.rec.Sleeping, fmt.Sprint(ups))
	if !force && key == w.lastSync.route {
		return nil
	}
	if !proxy.HasRouteFile(spec) && w.lastSync.route == "" {
		// Never routed: no file to write or remove. (Tool hosts and
		// database certificates need a file without routes of their own.)
		w.lastSync.route = key
		return nil
	}
	if err := rt.Apply(ctx, spec, ups); err != nil {
		return err
	}
	w.lastSync.route = key
	return nil
}

func (w *worker) syncTunnel(ctx context.Context, spec *agentv1.ServiceSpec, live []liveInstance) {
	cf := w.r.o.Cloudflare
	if cf == nil {
		return
	}
	tun := spec.GetDevAccess().GetCloudflareTunnel()
	if spec.GetStopped() {
		// A stopped service has no tunnel; a sleeping one or a deploy gap
		// keeps it (an empty target).
		tun = nil
	}
	target := ""
	if len(live) > 0 && tun.GetEnabled() {
		port := tun.GetTargetPort()
		if port == 0 {
			port = routePort(spec)
		}
		if port != 0 {
			target = net.JoinHostPort(live[0].ip, strconv.Itoa(int(port)))
		}
	}
	key := keyOf(tun, target)
	if key == w.lastSync.tunnel || (!tun.GetEnabled() && w.lastSync.tunnel == "") {
		return
	}
	if !tun.GetEnabled() {
		tun = &agentv1.CloudflareTunnel{}
	}
	url, err := cf.Sync(ctx, spec.GetId(), target, tun)
	if err != nil {
		w.log.Warn("syncing cloudflare tunnel", "err", err)
		w.retryLater(15 * time.Second)
		return
	}
	w.lastSync.tunnel = key
	w.tunnelURL = url
}

// TunnelURLs is optionally implemented by the Cloudflare component: the
// current URL of a quick tunnel, which changes when cloudflared restarts
// and is known only a few seconds after Sync.
type TunnelURLs interface {
	URL(serviceID string) string
}

// attachProxy connects Traefik to a project network so it can reach the
// project's routed containers by name.
func (r *Runtime) attachProxy(ctx context.Context, projectID string) {
	names := []string{docker.TraefikContainer}
	if pc, ok := r.o.Router.(ProxyContainers); ok {
		n, err := pc.ProxyContainers(ctx)
		if err != nil {
			r.log.Warn("listing proxy containers", "err", err)
			return
		}
		names = n
	}
	net := docker.ProjectNetwork(projectID)
	for _, n := range names {
		r.connectProxy(ctx, net, n)
	}
}

// connectProxy connects the proxy container name to net unless it is
// there already. A proxy that is missing, stopped or being removed is left
// alone: it is being recreated (a Traefik config change replaces the
// container), and the loop that keeps it running attaches every routed
// project network once it starts. Connecting by name in that window hits
// the old container while Docker removes it.
func (r *Runtime) connectProxy(ctx context.Context, net, name string) {
	d, err := r.o.Docker.InspectContainer(ctx, name)
	if errors.Is(err, docker.ErrNotFound) {
		return
	}
	if err != nil {
		r.log.Warn("inspecting the proxy container", "container", name, "err", err)
		return
	}
	if _, ok := d.Networks[net]; ok || !d.Running {
		return
	}
	err = r.o.Docker.ConnectNetwork(ctx, net, name, nil)
	if err == nil {
		return
	}
	if errors.Is(err, docker.ErrRemoving) || (errors.Is(err, docker.ErrNotFound) && r.proxyGone(ctx, name)) {
		r.log.Debug("the proxy container is being replaced; its new container gets the network", "container", name, "network", net, "err", err)
		return
	}
	r.log.Warn("connecting the proxy to a project network", "container", name, "network", net, "err", err)
}

// proxyGone reports whether the proxy container no longer exists.
func (r *Runtime) proxyGone(ctx context.Context, name string) bool {
	_, err := r.o.Docker.InspectContainer(ctx, name)
	return errors.Is(err, docker.ErrNotFound)
}

// syncNetworks removes project networks no desired service uses any more.
// The proxy is disconnected first; networks other containers still use are
// left for a later pass.
func (r *Runtime) syncNetworks(ctx context.Context) {
	r.mu.Lock()
	want := map[string]bool{}
	for _, n := range r.desired.GetNetworks() {
		want[docker.ProjectNetwork(n.GetProjectId())] = true
	}
	for _, s := range r.desired.GetServices() {
		want[docker.ProjectNetwork(s.GetProjectId())] = true
	}
	busy := len(r.pending) > 0
	r.mu.Unlock()
	if busy {
		// Workers may still be removing containers; try again on the next
		// resync.
		return
	}
	// A network our containers still use stays, with the proxy on it: a
	// service whose move to another project failed keeps serving from the
	// old project's network until the panel moves it back.
	inUse, err := r.o.Docker.ListContainers(ctx, r.scoped(nil))
	if err != nil {
		r.log.Warn("listing containers", "err", err)
		return
	}
	for _, c := range inUse {
		if docker.IsServiceInstance(c.Labels) {
			if p := r.projectOf(c.ID, c.Labels); p != "" {
				want[docker.ProjectNetwork(p)] = true
			}
		}
	}
	nets, err := r.o.Docker.ListNetworks(ctx, r.scoped(nil))
	if err != nil {
		r.log.Warn("listing networks", "err", err)
		return
	}
	prefix := docker.ProjectNetwork("")
	for _, n := range nets {
		if !strings.HasPrefix(n.Name, prefix) || want[n.Name] {
			continue
		}
		if p, ok := r.o.Router.(ProxyContainers); ok {
			if names, err := p.ProxyContainers(ctx); err == nil {
				for _, c := range names {
					_ = r.o.Docker.DisconnectNetwork(ctx, n.Name, c)
				}
			}
		} else {
			_ = r.o.Docker.DisconnectNetwork(ctx, n.Name, docker.TraefikContainer)
		}
		if err := r.o.Docker.RemoveNetwork(ctx, n.Name); err != nil {
			r.log.Debug("project network still in use", "network", n.Name, "err", err)
		}
	}
}

// publishStatus reports the service's status when it changed.
func (w *worker) publishStatus(ctx context.Context, spec *agentv1.ServiceSpec) {
	st := w.buildStatus(ctx, spec)
	w.r.setPhase(w.id, st.GetPhase(), false)
	if w.last != nil && proto.Equal(withoutTime(w.last), withoutTime(st)) {
		return
	}
	w.last = st
	if w.r.o.State != nil {
		w.r.o.State.SetService(proto.Clone(st).(*agentv1.ServiceStatus))
	}
}

func withoutTime(s *agentv1.ServiceStatus) *agentv1.ServiceStatus {
	c := proto.Clone(s).(*agentv1.ServiceStatus)
	c.UpdatedAt = nil
	return c
}

// repoDigest is the registry digest of a container's image, so the panel
// can roll back to the same bytes of an image pulled by tag. Images with
// no repo digest (built locally, never pushed) report "": an image id is
// not something a node can pull.
func (w *worker) repoDigest(ctx context.Context, ref, imageID string) string {
	if imageID == "" {
		return ""
	}
	if dg, ok := w.digests[imageID]; ok {
		return dg
	}
	img, err := w.r.o.Docker.InspectImage(ctx, imageID)
	if err != nil {
		return "" // not cached: try again on the next pass
	}
	dg := docker.RepoDigest(ref, img.RepoDigests)
	if w.digests == nil {
		w.digests = map[string]string{}
	}
	w.digests[imageID] = dg
	return dg
}

func (w *worker) buildStatus(ctx context.Context, spec *agentv1.ServiceSpec) *agentv1.ServiceStatus {
	st := &agentv1.ServiceStatus{
		ServiceId:   w.id,
		Generation:  spec.GetGeneration(),
		Message:     w.message,
		UpdatedAt:   timestamppb.New(w.r.o.Now()),
		CrashStreak: w.r.o.Crash.Streak(w.id),
		TunnelUrl:   w.tunnelURL,
	}
	if u, ok := w.r.o.Cloudflare.(TunnelURLs); ok {
		st.TunnelUrl = u.URL(w.id)
	}
	if fn := w.r.webUI.Load(); fn != nil && spec.GetDatabase().GetTools().GetWebUi() {
		st.WebUi = (*fn)(w.id)
	}
	list, err := w.instances(ctx)
	if err != nil {
		st.Phase = agentv1.ServicePhase_SERVICE_PHASE_UNSPECIFIED
		st.Message = "docker: " + err.Error()
		return st
	}
	hash := SpecHash(spec)
	servingHash := false
	var running, unhealthy, waiting int
	var newestGen uint64
	for _, c := range list {
		d, err := w.r.o.Docker.InspectContainer(ctx, c.ID)
		if err != nil {
			continue
		}
		gen := labelUint(c, docker.LabelGeneration)
		inst := &agentv1.Instance{
			ContainerId:   d.ID,
			ContainerName: d.Name,
			Generation:    gen,
			Replica:       uint32(labelUint(c, docker.LabelReplica)),
			State:         d.State,
			ImageDigest:   w.repoDigest(ctx, d.Image, d.ImageID),
			RestartCount:  uint32(d.RestartCount),
		}
		if !d.StartedAt.IsZero() {
			inst.StartedAt = timestamppb.New(d.StartedAt)
		}
		if wt := w.watches[d.ID]; wt != nil && d.Running {
			inst.Health = wt.State()
		}
		st.Instances = append(st.Instances, inst)
		if w.hashOf(c.ID, c.Labels, spec, hash) == hash {
			if d.Running {
				servingHash = true
				running++
				if inst.Health == agentv1.HealthState_HEALTH_STATE_UNHEALTHY {
					unhealthy++
				}
			} else if _, ok := w.restartAt[d.ID]; ok {
				waiting++
			}
		} else if d.Running && gen > newestGen {
			newestGen = gen
		}
	}
	if !servingHash && newestGen > 0 {
		// An older generation still serves (failed or ongoing deploy).
		st.Generation = newestGen
	}
	if g := w.r.o.Gate; g != nil {
		st.OpenPorts = g.Ports(w.id)
	}
	if rt := w.r.o.Router; rt != nil && len(spec.GetRouting().GetRoutes()) > 0 {
		if routes, err := rt.Status(ctx, w.id); err == nil {
			st.Routes = routes
		}
	}
	switch {
	case spec.GetKind() == agentv1.ServiceKind_SERVICE_KIND_CRON:
		st.Phase = agentv1.ServicePhase_SERVICE_PHASE_RUNNING
		if st.Message == "" {
			st.Message = "runs on its schedule"
		}
	case spec.GetStopped():
		st.Phase = agentv1.ServicePhase_SERVICE_PHASE_STOPPED
	case w.rec.Sleeping:
		st.Phase = agentv1.ServicePhase_SERVICE_PHASE_SLEEPING
	case w.phase != agentv1.ServicePhase_SERVICE_PHASE_UNSPECIFIED:
		st.Phase = w.phase
	case w.rec.HaltedHash == hash:
		st.Phase = agentv1.ServicePhase_SERVICE_PHASE_FAILED
	case waiting > 0:
		st.Phase = agentv1.ServicePhase_SERVICE_PHASE_CRASH_LOOPING
	case running == 0 && newestGen > 0:
		st.Phase = agentv1.ServicePhase_SERVICE_PHASE_RUNNING
	case running == 0 && w.rec.FailedHash == hash:
		st.Phase = agentv1.ServicePhase_SERVICE_PHASE_FAILED
	case running == 0:
		st.Phase = agentv1.ServicePhase_SERVICE_PHASE_PENDING
	case unhealthy > 0 || running < replicas(spec):
		st.Phase = agentv1.ServicePhase_SERVICE_PHASE_DEGRADED
	default:
		st.Phase = agentv1.ServicePhase_SERVICE_PHASE_RUNNING
	}
	return st
}

func redactLines(lines []string, spec *agentv1.ServiceSpec) []string {
	return crash.Redact(lines, crash.SecretValues(spec))
}

// Resolve returns the address ("10.0.3.4:5432") of a running instance of
// the service's current spec on its project network, for relaying to
// containerPort. Replicas take turns.
func (r *Runtime) Resolve(ctx context.Context, serviceID string, containerPort uint32) (string, error) {
	spec := r.spec(serviceID)
	if spec == nil {
		return "", fmt.Errorf("%w: %s", ErrUnknownService, serviceID)
	}
	if containerPort == 0 {
		return "", fmt.Errorf("no container port given")
	}
	list, err := r.o.Docker.ListContainers(ctx, r.scoped(map[string]string{docker.LabelService: serviceID}))
	if err != nil {
		return "", err
	}
	hash := SpecHash(spec)
	var addrs, fallback []string
	for _, c := range list {
		if !docker.IsServiceInstance(c.Labels) || c.State != agentv1.InstanceState_INSTANCE_STATE_RUNNING {
			continue
		}
		// Each container on its own project's network: during a move to
		// another project the old copies are still on the old one.
		network := docker.ProjectNetwork(r.projectOf(c.ID, c.Labels))
		d, err := r.o.Docker.InspectContainer(ctx, c.ID)
		if err != nil || !d.Running || d.Networks[network] == "" {
			continue
		}
		a := net.JoinHostPort(d.Networks[network], strconv.Itoa(int(containerPort)))
		served := instanceHash(c.Labels, spec, hash)
		if v, ok := r.reattached.Load(c.ID); ok {
			served = v.(reattachment).Hash
		}
		if served == hash {
			addrs = append(addrs, a)
		} else {
			// An older generation while a deploy is in flight or failed.
			fallback = append(fallback, a)
		}
	}
	if len(addrs) == 0 {
		addrs = fallback
	}
	if len(addrs) == 0 {
		return "", fmt.Errorf("%w: no running instance of %s", ErrNotRunning, serviceID)
	}
	n := r.resolveTurn.Add(1)
	return addrs[int(n%uint64(len(addrs)))], nil
}
