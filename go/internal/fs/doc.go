// Package fs is file access inside service volumes for the Files button.
// Every path is resolved relative to the volume root through os.Root,
// which walks one component at a time with openat and O_NOFOLLOW and
// rejects symlinks and ".." that would leave the root, so a container that
// plants a malicious symlink in its volume cannot make the agent (root)
// read or write anything outside it. This is the guarantee Wings' ufs gets
// from openat2(RESOLVE_IN_ROOT), from the standard library instead of
// hand-written syscalls; the operation set and upload/archive behaviour
// follow the Wings fork's server/filesystem (MIT).
//
// New files and folders take the owner of their parent folder, uploads
// replace files atomically (temporary file, then rename), and extraction
// refuses path traversal and leaves out symlinks that point outside.
//
// Interfaces used by other packages:
//
//   - Roots and FS: the Fs* RPC handlers and backup (volume archives) use
//     them.
package fs
