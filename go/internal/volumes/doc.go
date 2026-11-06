// Package volumes moves service volumes between nodes. There is no
// cross-node network, so the panel relays the bytes: ExportVolume on the
// source node streams one volume as .tar.gz (paths relative to the volume
// root, owners, modes, times, symlinks and hard links kept) and
// ImportVolume on the target unpacks it.
//
// Unpacking goes through os.Root, so an archive cannot write outside the
// volume folder: absolute paths, "..", and symlinks that point out of the
// volume are all refused by the kernel-checked root, not by string tests.
//
// A volume lives in its owner's folder (VolumeMount.owner_service_id for
// compose stacks sharing one volume); callers pass that owner.
//
// Archiving reads a folder a container may be writing to, as root, so it
// never opens anything by path: WriteArchive walks through os.Root one
// name at a time and checks every opened file and folder against the
// listing (same inode, still regular), so a file or folder swapped for a
// symlink mid-walk is skipped instead of followed to a host file.
//
// Interfaces used by other packages:
//
//   - Transfer: the ExportVolume and ImportVolume handlers in the agent's
//     wire_runtime.go call Export and Import.
//   - WriteArchive: any archive of a live volume (backups use it with
//     DotPrefix).
package volumes
