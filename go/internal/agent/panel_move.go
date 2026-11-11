package agent

// Moving the panel to another node (panel.relocate.v1, panel_move.proto):
// the handlers. The address staging is the connector's (panel_stage.go),
// the rest is update.PanelMover's. The node area registers them
// (wire_node.go): any agent that runs protected services can take the
// panel, like node.panel-update.v1.

import (
	"context"
	"errors"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/registry"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/update"
)

func registerPanelMove(reg *Registry, d *Deps, mover *update.PanelMover) {
	registerPanelStage(reg, d)
	registerMover(reg, d, mover)
}

// privateSession refuses a step that ships the panel's data or keys, or
// switches to the moved panel, over a plain-HTTP session from another
// host (a node that joined over http://): anyone on the path could read
// master.key or forge the step.
func privateSession(d *Deps, what string) error {
	if d.PanelStage == nil {
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, "the agent's panel connection is not ready")
	}
	return d.PanelStage.CheckPrivateSession(what)
}

// registerPanelStage registers StagePanelAddress and ClearPanelAddress.
func registerPanelStage(reg *Registry, d *Deps) {
	rpc.HandleUnary(reg, "StagePanelAddress", func(ctx context.Context, req *agentv1.StagePanelAddressRequest) (*agentv1.StagePanelAddressResponse, error) {
		if d.PanelStage == nil {
			return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, "the agent's panel connection is not ready")
		}
		return d.PanelStage.StagePanelAddress(ctx, req)
	})
	rpc.HandleUnary(reg, "ClearPanelAddress", func(ctx context.Context, req *agentv1.ClearPanelAddressRequest) (*agentv1.ClearPanelAddressResponse, error) {
		if d.PanelStage == nil {
			return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, "the agent's panel connection is not ready")
		}
		if err := d.PanelStage.ClearPanelAddress(ctx, req); err != nil {
			return nil, err
		}
		return &agentv1.ClearPanelAddressResponse{}, nil
	})
}

// registerMover registers the methods update.PanelMover serves.
func registerMover(reg *Registry, d *Deps, mover *update.PanelMover) {
	rpc.HandleRaw(reg, "ImportPanelData", func(ctx context.Context, req *agentv1.ImportPanelDataRequest, s rpc.RawStream) (*agentv1.ImportPanelDataResponse, error) {
		if err := privateSession(d, "the panel's keys and database would cross the network unencrypted"); err != nil {
			return nil, err
		}
		res, err := mover.ImportPanelData(ctx, req, s)
		if err != nil {
			return nil, moveStatus(err)
		}
		return res, nil
	})
	rpc.HandleRaw(reg, "ExportRegistry", func(ctx context.Context, req *agentv1.ExportRegistryRequest, s rpc.RawStream) (*agentv1.ExportRegistryResponse, error) {
		res, err := mover.ExportRegistry(ctx, req, s)
		if err != nil {
			return nil, moveStatus(err)
		}
		return res, nil
	})
	rpc.HandleRaw(reg, "ImportRegistry", func(ctx context.Context, req *agentv1.ImportRegistryRequest, s rpc.RawStream) (*agentv1.ImportRegistryResponse, error) {
		if err := privateSession(d, "anyone on the path could replace the panel's images"); err != nil {
			return nil, err
		}
		res, err := mover.ImportRegistry(ctx, req, s)
		if err != nil {
			return nil, moveStatus(err)
		}
		return res, nil
	})
	rpc.HandleUnary(reg, "StartMovedPanel", func(ctx context.Context, req *agentv1.StartMovedPanelRequest) (*agentv1.StartMovedPanelResponse, error) {
		if err := privateSession(d, "anyone on the path could start a panel on this node"); err != nil {
			return nil, err
		}
		res, err := mover.Start(ctx, req)
		if err != nil {
			return nil, moveStatus(err)
		}
		return res, nil
	})
	rpc.HandleUnary(reg, "AbortMovedPanel", func(ctx context.Context, req *agentv1.AbortMovedPanelRequest) (*agentv1.AbortMovedPanelResponse, error) {
		if err := mover.Abort(ctx, req); err != nil {
			return nil, moveStatus(err)
		}
		return &agentv1.AbortMovedPanelResponse{}, nil
	})
	rpc.HandleUnary(reg, "CommitMovedPanel", func(ctx context.Context, req *agentv1.CommitMovedPanelRequest) (*agentv1.CommitMovedPanelResponse, error) {
		if err := privateSession(d, "anyone on the path could switch the nodes to a moved panel"); err != nil {
			return nil, err
		}
		if err := mover.Commit(ctx, req); err != nil {
			return nil, moveStatus(err)
		}
		return &agentv1.CommitMovedPanelResponse{}, nil
	})
	rpc.HandleUnary(reg, "RetirePanel", func(ctx context.Context, req *agentv1.RetirePanelRequest) (*agentv1.RetirePanelResponse, error) {
		if err := mover.Retire(ctx, req); err != nil {
			return nil, moveStatus(err)
		}
		return &agentv1.RetirePanelResponse{}, nil
	})
	rpc.HandleUnary(reg, "RemoveOldPanel", func(ctx context.Context, req *agentv1.RemoveOldPanelRequest) (*agentv1.RemoveOldPanelResponse, error) {
		res, err := mover.RemoveOld(ctx, req)
		if err != nil {
			return nil, moveStatus(err)
		}
		return res, nil
	})
}

// moveStatus answers a failed step with its code and, in the details,
// its reason (update.Reason*).
func moveStatus(err error) error {
	var me *update.MoveError
	if errors.As(err, &me) {
		e := rpc.NewError(me.Code, me.Error())
		if me.Reason != "" {
			e.Details = map[string]string{"reason": me.Reason}
		}
		return e
	}
	return updateStatus(err)
}

// moveHost is what the panel move does with Docker on this node. Fields
// read d.Docker at call time.
func moveHost(d *Deps) update.MoveHost {
	containers := func(ctx context.Context, labels map[string]string) ([]docker.Container, error) {
		if d.Docker == nil {
			return nil, update.ErrRuntimeNotReady
		}
		return d.Docker.ListContainers(ctx, labels)
	}
	stop := func(ctx context.Context, id string) error {
		if d.Docker == nil {
			return update.ErrRuntimeNotReady
		}
		if err := d.Docker.StopContainer(ctx, id, 0); err != nil && !errors.Is(err, docker.ErrNotFound) {
			return err
		}
		return nil
	}
	remove := func(ctx context.Context, id string) error {
		if err := stop(ctx, id); err != nil {
			return err
		}
		return d.Docker.RemoveContainer(ctx, id)
	}
	registryContainers := func(ctx context.Context) ([]docker.Container, error) {
		return containers(ctx, map[string]string{docker.LabelRole: registry.RoleRegistry})
	}
	return update.MoveHost{
		PanelContainers: func(ctx context.Context) ([]update.PanelContainer, error) {
			list, err := containers(ctx, map[string]string{docker.LabelService: docker.PanelServiceID})
			if err != nil {
				return nil, err
			}
			var out []update.PanelContainer
			for _, c := range list {
				if !docker.IsServiceInstance(c.Labels) || c.Labels[docker.LabelProtected] != "true" {
					continue
				}
				switch c.State {
				case agentv1.InstanceState_INSTANCE_STATE_CREATED, agentv1.InstanceState_INSTANCE_STATE_EXITED, agentv1.InstanceState_INSTANCE_STATE_DEAD:
					out = append(out, update.PanelContainer{ID: c.ID, Name: c.Name})
				default:
					// Running, restarting, or a state Docker did not name: as good as running.
					out = append(out, update.PanelContainer{ID: c.ID, Name: c.Name, Running: true})
				}
			}
			return out, nil
		},
		StopContainer:   stop,
		RemoveContainer: remove,
		StopRegistry: func(ctx context.Context) error {
			list, err := registryContainers(ctx)
			if err != nil {
				return err
			}
			for _, c := range list {
				if err := stop(ctx, c.ID); err != nil {
					return err
				}
			}
			return nil
		},
		RemoveRegistry: func(ctx context.Context) error {
			list, err := registryContainers(ctx)
			if err != nil {
				return err
			}
			for _, c := range list {
				if err := remove(ctx, c.ID); err != nil {
					return err
				}
			}
			return nil
		},
	}
}
