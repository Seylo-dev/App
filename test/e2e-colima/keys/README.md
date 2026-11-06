# TEST-ONLY signing key

`e2e-test.key` / `e2e-test.pub` is a throwaway minisign key pair (no password)
for the end-to-end harness only. It signs the release manifests and checksums
that `test/e2e-colima/build.sh` serves from the Mac's local release server.

Never put this public key in `brand/brand.json` and never trust it in a real
build: the secret key is committed on purpose so the e2e is repeatable.
Release builds cannot pick it up: the agent and the panel trust a test key
only when it is compiled in (`-X .../internal/update.TestReleasePublicKey`,
`bun build --define __TEST_RELEASE_PUBLIC_KEY__`), which only
`test/e2e-colima/build.sh` does, and `make release` refuses to run when
brand.json names this key or `INSTALLER_TEST_PUBLIC_KEY` is set
(`scripts/release-preflight.sh`).
