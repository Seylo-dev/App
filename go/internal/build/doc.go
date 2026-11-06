// Package build builds images on nodes with can_build and pushes them to
// the panel registry through 127.0.0.1:5755, so an image is built once and
// pulled by digest on any node.
//
// Sources: git (HTTPS with a token handed to git by a credential helper,
// so it never lands in .git/config, the URL or the process list; or an SSH
// key with pinned known_hosts), an uploaded .tar.gz context, a Dockerfile
// typed in the panel, or an existing image that is pulled (logged in for
// that pull only) and re-pushed. Builders: Railpack (default; the pinned
// binary is installed into <datadir>/tools on first use and its plan is
// built by the pinned BuildKit frontend), Nixpacks (pinned, generates a
// Dockerfile) and plain Dockerfiles (path, target stage, build args).
// Every variable is a BuildKit secret file for Railpack and Dockerfile
// builds; only non-secret ones are also Dockerfile build args. Nixpacks
// bakes what it sees into the image, so it only gets non-secret ones.
//
// Every build runs on one docker-container buildx builder per node, capped
// at a quarter of the machine (2-8 cores, 4-16 GB) under seylo.slice, and
// waits in a FIFO queue sized by NodeSettings.max_parallel_builds. Builds
// are detached jobs: output is kept for re-attaching watchers, the final
// result is queued in the durable outbox, and CancelBuild stops one. Local
// images beyond keep_images per service are removed after each build and
// BuildKit cache unused for a week is pruned.
//
// Ported in part from an earlier in-house implementation by the same
// authors (credential helper, buildx sizing, queue, retention).
//
// Interfaces used by other packages:
//
//   - Builder (Service): the RPC handlers for Build, CancelBuild and
//     UploadBuildContext call it.
package build
