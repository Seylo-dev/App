package backup

import (
	"context"
	"errors"
	"fmt"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// volumeFolder identifies the folder a mount resolves to: the owner
// service and the volume name (compose members share the owner's folder).
type volumeFolder struct{ owner, name string }

func folderOf(spec *agentv1.ServiceSpec, v *agentv1.VolumeMount) volumeFolder {
	owner := v.GetOwnerServiceId()
	if owner == "" {
		owner = spec.GetId()
	}
	return volumeFolder{owner: owner, name: v.GetName()}
}

// mounters lists the services that mount the same folder as spec's volume:
// spec first, then every other service in the desired state (read-only
// mounts only when writersOnly is false). Without Options.Services only
// spec is known.
func (l *Local) mounters(spec *agentv1.ServiceSpec, volume string, writersOnly bool) []string {
	ids := []string{spec.GetId()}
	var want volumeFolder
	found := false
	for _, v := range spec.GetVolumes() {
		if v.GetName() == volume {
			want, found = folderOf(spec, v), true
			break
		}
	}
	if !found || l.opts.Services == nil {
		return ids
	}
	for _, other := range l.opts.Services() {
		if other.GetId() == spec.GetId() {
			continue
		}
		for _, v := range other.GetVolumes() {
			if folderOf(other, v) == want && (!writersOnly || !v.GetReadOnly()) {
				ids = append(ids, other.GetId())
				break
			}
		}
	}
	return ids
}

// suspendAll stops every service in ids, in order. On a failure the ones
// already stopped are started again. The returned resume starts them in
// reverse order and reports every failure.
func (l *Local) suspendAll(ctx context.Context, ids []string) (func(context.Context) error, error) {
	resumes := make([]func(context.Context) error, 0, len(ids))
	resumeAll := func(ctx context.Context) error {
		var errs []error
		for i := len(resumes) - 1; i >= 0; i-- {
			if err := resumes[i](ctx); err != nil {
				errs = append(errs, err)
			}
		}
		return errors.Join(errs...)
	}
	for _, id := range ids {
		resume, err := l.opts.Suspend(ctx, id)
		if err != nil {
			err = fmt.Errorf("stopping %s: %w", id, err)
			return nil, errors.Join(err, resumeAll(context.WithoutCancel(ctx)))
		}
		resumes = append(resumes, resume)
	}
	return resumeAll, nil
}
