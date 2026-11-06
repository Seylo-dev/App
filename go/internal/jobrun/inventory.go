package jobrun

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/moby/moby/client"

	"github.com/seylo-dev/app/go/internal/docker"
)

// Inventory listings for cleanup. Each one asks the daemon for managed
// resources only and checks the label again on our side: removing
// something that is not ours is the one thing cleanup must never do.

// Image is a managed image.
type Image struct {
	ID          string
	RepoTags    []string
	RepoDigests []string
	Labels      map[string]string
	Created     time.Time
	// Size is what removing the image frees (shared layers excluded).
	Size int64
	// Containers using it (any state), -1 when unknown.
	Containers int64
}

// Volume is a managed Docker volume.
type Volume struct {
	Name       string
	Labels     map[string]string
	Mountpoint string
	Options    map[string]string
}

// Network is a managed Docker network.
type Network struct {
	ID     string
	Name   string
	Labels map[string]string
}

func managedFilter() client.Filters {
	return client.Filters{}.Add("label", docker.LabelManaged+"=true")
}

// ContainersWithSize lists every managed container with its writable
// layer size (SizeRw) and image id.
func (d *Docker) ContainersWithSize(ctx context.Context) ([]Container, error) {
	res, err := d.cli.ContainerList(ctx, client.ContainerListOptions{All: true, Size: true, Filters: managedFilter()})
	if err != nil {
		return nil, fmt.Errorf("listing containers: %w", err)
	}
	var out []Container
	for _, s := range res.Items {
		if !docker.IsManaged(s.Labels) {
			continue
		}
		c := Container{ID: s.ID, Image: s.Image, ImageID: s.ImageID, Labels: s.Labels, Running: s.State == "running",
			Created: time.Unix(s.Created, 0), SizeRw: s.SizeRw}
		if len(s.Names) > 0 {
			c.Name = strings.TrimPrefix(s.Names[0], "/")
		}
		out = append(out, c)
	}
	return out, nil
}

// Images lists managed images.
func (d *Docker) Images(ctx context.Context) ([]Image, error) {
	res, err := d.cli.ImageList(ctx, client.ImageListOptions{Filters: managedFilter(), SharedSize: true})
	if err != nil {
		return nil, fmt.Errorf("listing images: %w", err)
	}
	var out []Image
	for _, s := range res.Items {
		if !docker.IsManaged(s.Labels) {
			continue
		}
		// Layers shared with other images are not freed by removing this one.
		size := s.Size
		if s.SharedSize > 0 && s.SharedSize <= size {
			size -= s.SharedSize
		}
		out = append(out, Image{ID: s.ID, RepoTags: s.RepoTags, RepoDigests: s.RepoDigests, Labels: s.Labels,
			Created: time.Unix(s.Created, 0), Size: size, Containers: s.Containers})
	}
	return out, nil
}

// Volumes lists managed volumes.
func (d *Docker) Volumes(ctx context.Context) ([]Volume, error) {
	res, err := d.cli.VolumeList(ctx, client.VolumeListOptions{Filters: managedFilter()})
	if err != nil {
		return nil, fmt.Errorf("listing volumes: %w", err)
	}
	var out []Volume
	for _, v := range res.Items {
		if !docker.IsManaged(v.Labels) {
			continue
		}
		out = append(out, Volume{Name: v.Name, Labels: v.Labels, Mountpoint: v.Mountpoint, Options: v.Options})
	}
	return out, nil
}

// Networks lists managed networks.
func (d *Docker) Networks(ctx context.Context) ([]Network, error) {
	res, err := d.cli.NetworkList(ctx, client.NetworkListOptions{Filters: managedFilter()})
	if err != nil {
		return nil, fmt.Errorf("listing networks: %w", err)
	}
	var out []Network
	for _, n := range res.Items {
		if !docker.IsManaged(n.Labels) {
			continue
		}
		out = append(out, Network{ID: n.ID, Name: n.Name, Labels: n.Labels})
	}
	return out, nil
}

// ErrNotManaged is returned when asked to remove a resource without the
// managed label.
var ErrNotManaged = errors.New("refusing to remove a resource not managed by us")

// RemoveContainer removes a stopped managed container.
func (d *Docker) RemoveContainer(ctx context.Context, id string) error {
	c, found, err := d.Inspect(ctx, id)
	if err != nil || !found {
		return err
	}
	if !docker.IsManaged(c.Labels) {
		return ErrNotManaged
	}
	if c.Running {
		return fmt.Errorf("container %s is running", c.Name)
	}
	_, err = d.cli.ContainerRemove(ctx, id, client.ContainerRemoveOptions{})
	if err != nil && !IsNotFound(err) {
		return fmt.Errorf("removing container %s: %w", c.Name, err)
	}
	return nil
}

// RemoveImage removes a managed image (never forced, so an image a
// container still uses stays).
func (d *Docker) RemoveImage(ctx context.Context, id string) error {
	img, err := d.cli.ImageInspect(ctx, id)
	if IsNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspecting image %s: %w", id, err)
	}
	if img.Config == nil || !docker.IsManaged(img.Config.Labels) {
		return ErrNotManaged
	}
	_, err = d.cli.ImageRemove(ctx, id, client.ImageRemoveOptions{PruneChildren: true, Force: len(img.RepoTags) > 1})
	if err != nil && !IsNotFound(err) {
		return fmt.Errorf("removing image %s: %w", id, err)
	}
	return nil
}

// RemoveVolume removes a managed volume that no container uses.
func (d *Docker) RemoveVolume(ctx context.Context, name string) error {
	v, err := d.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{})
	if IsNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspecting volume %s: %w", name, err)
	}
	if !docker.IsManaged(v.Volume.Labels) {
		return ErrNotManaged
	}
	if _, err := d.cli.VolumeRemove(ctx, name, client.VolumeRemoveOptions{}); err != nil && !IsNotFound(err) {
		return fmt.Errorf("removing volume %s: %w", name, err)
	}
	return nil
}

// RemoveNetwork removes a managed network with no containers attached.
func (d *Docker) RemoveNetwork(ctx context.Context, id string) error {
	n, err := d.cli.NetworkInspect(ctx, id, client.NetworkInspectOptions{})
	if IsNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspecting network %s: %w", id, err)
	}
	if !docker.IsManaged(n.Network.Labels) {
		return ErrNotManaged
	}
	if len(n.Network.Containers) > 0 {
		return fmt.Errorf("network %s still has containers", n.Network.Name)
	}
	if _, err := d.cli.NetworkRemove(ctx, id, client.NetworkRemoveOptions{}); err != nil && !IsNotFound(err) {
		return fmt.Errorf("removing network %s: %w", n.Network.Name, err)
	}
	return nil
}
