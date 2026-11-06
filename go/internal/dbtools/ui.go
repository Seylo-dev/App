package dbtools

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

// Manager wakes database web UIs for the edge.
type Manager interface {
	// Wake starts the UI of a database service if needed and returns the
	// base URL the edge proxies to, for example "http://172.18.0.5:8081".
	// It returns ErrNotFound when the service is not a database on this
	// node or its web UI is turned off.
	Wake(ctx context.Context, serviceID string) (upstream string, err error)
	// Touch records activity so the idle stop does not hit an open session.
	Touch(serviceID string)
}

// ErrNotFound means there is no web UI to open for the service here.
var ErrNotFound = errors.New("no database web UI for this service on this node")

// DefaultIdle stops a UI after this long without traffic.
const DefaultIdle = 15 * time.Minute

// UI images, pinned. The agent picks them by engine; the panel sends none.
const (
	ImagePgweb        = "sosedoff/pgweb:0.17.0"
	ImagePhpMyAdmin   = "phpmyadmin:5.2.3"
	ImageMongoExpress = "mongo-express:1.0.2-20-alpine3.19"
	ImageRedisCmdr    = "ghcr.io/joeferner/redis-commander:0.9.1"
)

// uiName is the helper container of a database's UI.
func uiName(serviceID string) string { return jobrun.HelperName(serviceID, "db-ui") }

// uiTarget builds the helper for a database: image, sign-in env and port.
// sessionSecrets sign mongo-express cookies. They are made once per agent
// run: new ones on every wake would change the spec hash and recreate the
// container each time.
func uiTarget(spec *agentv1.ServiceSpec, sessionSecrets [2]string) (jobrun.Target, error) {
	db := spec.GetDatabase()
	if spec.GetKind() != agentv1.ServiceKind_SERVICE_KIND_DATABASE || db == nil {
		return jobrun.Target{}, ErrNotFound
	}
	c := db.GetCredentials()
	host := spec.GetName()
	port := enginePort(spec)
	ps := strconv.FormatUint(uint64(port), 10)
	t := jobrun.Target{Network: jobrun.ProjectNetwork(spec), Idle: DefaultIdle}
	if d := db.GetTools().GetWebUiIdleTimeout(); d != nil && d.AsDuration() > 0 {
		t.Idle = d.AsDuration()
	}
	s := jobrun.Spec{
		Name:     uiName(spec.GetId()),
		Labels:   jobrun.Labels(jobrun.OwnerOf(spec), jobrun.RoleDBUI, nil),
		Network:  t.Network,
		KeepLogs: true,
	}
	switch db.GetEngine() {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		u := url.URL{Scheme: "postgres", User: url.UserPassword(c.GetAdminUser(), c.GetAdminPassword()),
			Host: host + ":" + ps, Path: "/" + c.GetDatabase(), RawQuery: "sslmode=disable"}
		s.Image = ImagePgweb
		s.Env = []string{"PGWEB_DATABASE_URL=" + u.String(), "DATABASE_URL=" + u.String()}
		s.Cmd = []string{"/usr/bin/pgweb", "--bind=0.0.0.0", "--listen=8081", "--lock-session", "--skip-open"}
		t.Port = 8081
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		// PMA_USER and PMA_PASSWORD switch phpMyAdmin to config auth: it
		// signs in by itself.
		s.Image = ImagePhpMyAdmin
		s.Env = []string{"PMA_HOST=" + host, "PMA_PORT=" + ps, "PMA_USER=" + c.GetAdminUser(), "PMA_PASSWORD=" + c.GetAdminPassword()}
		t.Port = 80
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:
		u := url.URL{Scheme: "mongodb", Host: host + ":" + ps, Path: "/"}
		if c.GetAdminUser() != "" {
			u.User = url.UserPassword(c.GetAdminUser(), c.GetAdminPassword())
			u.RawQuery = "authSource=admin"
		}
		s.Image = ImageMongoExpress
		s.Env = []string{
			"ME_CONFIG_MONGODB_URL=" + u.String(),
			"ME_CONFIG_MONGODB_ENABLE_ADMIN=true",
			// The edge ticket is the login.
			"ME_CONFIG_BASICAUTH=false",
			"ME_CONFIG_BASICAUTH_ENABLED=false",
			"ME_CONFIG_SITE_COOKIESECRET=" + sessionSecrets[0],
			"ME_CONFIG_SITE_SESSIONSECRET=" + sessionSecrets[1],
		}
		t.Port = 8081
	case agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS:
		s.Image = ImageRedisCmdr
		s.Env = []string{"REDIS_HOST=" + host, "REDIS_PORT=" + ps, "REDIS_PASSWORD=" + c.GetAdminPassword()}
		if u := c.GetAdminUser(); u != "" && u != "default" {
			s.Env = append(s.Env, "REDIS_USERNAME="+u)
		}
		t.Port = 8081
	default:
		return jobrun.Target{}, fmt.Errorf("%w: unknown engine %v", ErrNotFound, db.GetEngine())
	}
	t.Spec = s
	return t, nil
}

func enginePort(spec *agentv1.ServiceSpec) uint32 {
	if ps := spec.GetPorts(); len(ps) > 0 && ps[0].GetContainerPort() != 0 {
		return ps[0].GetContainerPort()
	}
	switch spec.GetDatabase().GetEngine() {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		return 5432
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		return 3306
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:
		return 27017
	default:
		return 6379
	}
}

func randomHex() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("crypto/rand: %v", err))
	}
	return hex.EncodeToString(b[:])
}

// UIs is the Manager: it follows the desired state and runs the UIs on
// a jobrun.OnDemand.
type UIs struct {
	demand  *jobrun.OnDemand
	log     *slog.Logger
	secrets [2]string

	mu    sync.Mutex
	specs map[string]*agentv1.ServiceSpec
}

var _ Manager = (*UIs)(nil)

// NewUIs returns a manager running UIs through demand.
func NewUIs(demand *jobrun.OnDemand, logger *slog.Logger) *UIs {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &UIs{demand: demand, log: logger, secrets: [2]string{randomHex(), randomHex()}, specs: map[string]*agentv1.ServiceSpec{}}
}

// Sync takes the database services of the desired state. UIs of services
// that left or turned the UI off are stopped.
func (u *UIs) Sync(ctx context.Context, specs []*agentv1.ServiceSpec) {
	next := map[string]*agentv1.ServiceSpec{}
	for _, s := range specs {
		if s.GetKind() == agentv1.ServiceKind_SERVICE_KIND_DATABASE && s.GetDatabase().GetTools().GetWebUi() && !s.GetStopped() {
			next[s.GetId()] = s
		}
	}
	u.mu.Lock()
	var gone []string
	for id := range u.specs {
		if next[id] == nil {
			gone = append(gone, id)
		}
	}
	u.specs = next
	u.mu.Unlock()
	for _, id := range gone {
		if running, _ := u.demand.State(uiName(id)); running {
			if err := u.demand.Sleep(ctx, uiName(id)); err != nil {
				u.log.Warn("stopping database web UI", "service_id", id, "err", err)
			}
		}
	}
}

// Wake implements Manager.
func (u *UIs) Wake(ctx context.Context, serviceID string) (string, error) {
	u.mu.Lock()
	spec := u.specs[serviceID]
	u.mu.Unlock()
	if spec == nil {
		return "", ErrNotFound
	}
	t, err := uiTarget(spec, u.secrets)
	if err != nil {
		return "", err
	}
	return u.demand.Wake(ctx, t)
}

// Touch implements Manager.
func (u *UIs) Touch(serviceID string) { u.demand.Touch(uiName(serviceID)) }

// Status is the web UI's actual state for ServiceStatus.web_ui, nil when
// the service has no web UI here.
func (u *UIs) Status(serviceID string) *agentv1.ToolStatus {
	u.mu.Lock()
	_, ok := u.specs[serviceID]
	u.mu.Unlock()
	if !ok {
		return nil
	}
	running, started, last := u.demand.Info(uiName(serviceID))
	st := &agentv1.ToolStatus{Running: running}
	if running {
		st.StartedAt = timestamppb.New(started)
		st.LastActiveAt = timestamppb.New(last)
	}
	return st
}

// ServiceOf returns the service id of a web UI helper container name, or
// "" when name is not one.
func (u *UIs) ServiceOf(name string) string {
	u.mu.Lock()
	defer u.mu.Unlock()
	for id := range u.specs {
		if uiName(id) == name {
			return id
		}
	}
	return ""
}
