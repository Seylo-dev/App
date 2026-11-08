package datadir

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// PrivateDirMode is the mode of services/ and of every services/<id>/:
// only root may list or enter them. File mounts hold secrets and volumes
// hold the apps' data, and the data dir itself is 0711 (traversable), so
// a local account that learned a service id (from /proc/<pid>/mountinfo
// of any container process) could otherwise open them. Containers need
// no rights on these folders: dockerd sets up volumes and bind mounts as
// root, and the files and volume folders below keep the modes the
// processes in the container need.
const PrivateDirMode fs.FileMode = 0o700

// VolumeDirMode is the mode a new volume folder gets: its root is the
// mount point a container user writes to.
const VolumeDirMode fs.FileMode = 0o755

// MakeServiceDir creates services/ and services/<id>/ with PrivateDirMode
// and sets that mode when they already exist (agents before 0.2.0-rc.2
// made them 0755). It returns the service folder.
func (l Layout) MakeServiceDir(serviceID string) (string, error) {
	dir, err := l.ServiceDir(serviceID)
	if err != nil {
		return "", err
	}
	for _, d := range []string{l.ServicesDir(), dir} {
		if err := private(d); err != nil {
			return "", err
		}
	}
	return dir, nil
}

// MakeServiceVolume creates the folder of a service volume (VolumeDirMode)
// inside a private service folder (MakeServiceDir) and returns it.
func (l Layout) MakeServiceVolume(serviceID, volume string) (string, error) {
	vol, err := l.ServiceVolume(serviceID, volume)
	if err != nil {
		return "", err
	}
	if _, err := l.MakeServiceDir(serviceID); err != nil {
		return "", err
	}
	if err := os.MkdirAll(vol, VolumeDirMode); err != nil {
		return "", fmt.Errorf("creating volume folder: %w", err)
	}
	return vol, nil
}

// SecureServiceDirs sets PrivateDirMode on services/ and on every folder
// in it. The agent calls it when it starts, so folders an older agent made
// 0755 are closed before any service is deployed again. A node without
// services/ has nothing to do.
func (l Layout) SecureServiceDirs() error {
	root := l.ServicesDir()
	if err := os.Chmod(root, PrivateDirMode); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("securing %s: %w", root, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("securing %s: %w", root, err)
	}
	var errs []error
	for _, e := range entries {
		// Type is from lstat: a symlink here is not ours and is left alone.
		if !e.IsDir() {
			continue
		}
		if err := os.Chmod(filepath.Join(root, e.Name()), PrivateDirMode); err != nil && !errors.Is(err, fs.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// private creates dir (parents included) with PrivateDirMode, or sets that
// mode on the folder already there.
func private(dir string) error {
	if err := os.MkdirAll(dir, PrivateDirMode); err != nil {
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	if err := os.Chmod(dir, PrivateDirMode); err != nil {
		return fmt.Errorf("securing %s: %w", dir, err)
	}
	return nil
}
