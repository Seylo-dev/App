# Common tasks. Run from the repository root. Needs Go, Bun and buf; see
# CONTRIBUTING.md for versions.

GO_DIRS := go tools/brandgen

# Exports installer/brand.env (BRAND_SLUG, BRAND_IMAGE, ...) plus
# BRAND_ENV_PREFIX for the release targets, so nothing below types the brand.
# GO_MODULE (from go/go.mod) names the packages the -X linker flags set.
BRAND_ENV = set -a && . installer/brand.env && BRAND_ENV_PREFIX=$$(printf %s "$$BRAND_SLUG" | tr '[:lower:]-' '[:upper:]_') && GO_MODULE=$(GO_MODULE) && set +a &&
VERSION ?= dev
GO_MODULE := $(shell sed -n 's/^module //p' go/go.mod)
VERSION_PKG := $(GO_MODULE)/internal/version

.PHONY: help install gen gen-brand gen-proto gen-ts check-gen build build-go build-ts test test-go test-ts lint breaking \
	test-installer test-release installer panel-image release-check release-snapshot release-dry-run release-draft release e2e e2e-checks e2e-refresh e2e-down

help: ## List targets
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-17s %s\n", $$1, $$2}'

install: ## Install JS dependencies (needed for TS codegen and tests)
	bun install --frozen-lockfile

gen: gen-brand gen-proto gen-ts installer ## Regenerate all generated code

gen-brand: ## brand/brand.json -> Go, TS and installer constants
	go -C tools/brandgen run . -root ../..

gen-proto: ## proto/ -> go/gen/pb and packages/proto/src/gen
	buf generate
	scripts/gen-proto-index.sh

gen-ts: ## Op and module indexes, openapi.json, the web route tree
	bun run scripts/gen-indexes.ts
	bun run scripts/gen-openapi.ts
	bun run --filter @seylo/web routes

check-gen: ## Fail when generated code is stale (CI runs this)
	scripts/check-generated.sh

build: build-go build-ts ## Build the seylo binary and the panel with its web app

build-go: ## Static bin/seylo (CGO_ENABLED=0; set GOOS/GOARCH to cross-compile)
	CGO_ENABLED=0 go -C go build -trimpath -ldflags "-X $(VERSION_PKG).Version=$(VERSION)" -o ../bin/seylo ./cmd/seylo

build-ts: ## apps/web/dist, then apps/panel/dist
	bun run build

test: test-go test-ts test-installer test-release ## Run Go, TypeScript, installer and release script tests

test-go: ## Go tests with the race detector
	@for d in $(GO_DIRS); do go -C $$d test -race ./... || exit 1; done

test-ts: ## bun test in every workspace
	bun run test

test-installer: ## install.sh in --root mode against a fake signed release (skips without minisign), and the panel image entrypoint
	installer/test/run.sh
	deploy/test/panel-entrypoint.sh

test-release: ## No write-token job runs npm (scripts/check-release-workflow.ts); release-sign.sh and release-publish.sh against fake releases and ghcr.io (skip without minisign or jq)
	bun scripts/check-release-workflow.ts
	installer/test/release-sign.sh
	installer/test/release-publish.sh

lint: ## buf lint, gofmt, go vet, staticcheck, Biome, tsc
	buf lint
	@unformatted="$$(gofmt -l go tools)"; if [ -n "$$unformatted" ]; then echo "gofmt needed:"; echo "$$unformatted"; exit 1; fi
	@for d in $(GO_DIRS); do go -C $$d vet ./... || exit 1; done
	go -C go tool staticcheck ./...
	bun run lint
	bun run typecheck

breaking: ## Check proto changes against main for breaking changes
	buf breaking --against '.git#branch=main'

installer: ## Render installer/install.sh from install.sh.tmpl and brand.env
	scripts/render-installer.sh

panel-image: build-ts ## Build the panel image for this machine as <image>:$(VERSION)
	$(BRAND_ENV) docker build -f deploy/panel.Dockerfile \
		--build-arg VERSION=$(VERSION) --build-arg ENV_PREFIX=$$BRAND_ENV_PREFIX --build-arg DATA_DIR=$$BRAND_DATA_DIR \
		-t $$BRAND_IMAGE:$(VERSION) .

release-check: ## Validate .goreleaser.yaml
	$(BRAND_ENV) goreleaser check

# The before hooks are skipped, so build/install.sh is rendered first:
# checksums.txt lists it (.goreleaser.yaml checksum.extra_files).
release-snapshot: ## Build the release binaries and install.sh into dist/ (no publish, sign or image)
	scripts/render-installer.sh latest build/install.sh
	$(BRAND_ENV) goreleaser release --snapshot --clean --skip=sign,docker,before
	cp build/install.sh dist/install.sh

# goreleaser runs no npm package: the panel image packages apps/web/dist and
# apps/panel/dist as `make build-ts` left them (in a tag release, the Build
# and test job's artifact), so the release targets that hold GITHUB_TOKEN run
# none of the build's npm code. They stop when the build is missing.
TS_BUILT = test -f apps/web/dist/index.html && test -f apps/panel/dist/main.js || \
	{ echo "no build in apps/web/dist and apps/panel/dist: run make build-ts first" >&2; exit 1; }

release-dry-run: ## goreleaser as a release runs it, publishing nothing: snapshot, one panel image per platform loaded locally, nothing signed (run make build-ts first)
	@$(TS_BUILT)
	$(BRAND_ENV) goreleaser release --snapshot --clean

# The Draft release job of a tag release: everything but the signatures, with
# no signing key around and no npm package run (the web app and the panel are
# the Build and test job's). The Sign job signs dist/release/ with
# scripts/release-sign.sh.
release-draft: ## Draft release from a v* tag, unsigned, of the build in apps/*/dist: goreleaser (draft, image push), manifest.json, dist/release/ (GITHUB_TOKEN, docker login)
	$(BRAND_ENV) scripts/release-preflight.sh --no-secret-key
	@$(TS_BUILT)
	$(BRAND_ENV) goreleaser release --clean
	$(BRAND_ENV) scripts/release-manifest.sh

# Local fallback for the Build and test, Draft release and Sign jobs
# together, on one machine: it builds the TypeScript itself, with the token
# and the key around.
release: ## Signed draft release from a v* tag (GITHUB_TOKEN, MINISIGN_SECRET_KEY, MINISIGN_PASSWORD, docker login)
	$(BRAND_ENV) scripts/release-preflight.sh
	bun install --frozen-lockfile
	bun run build
	$(BRAND_ENV) goreleaser release --clean
	$(BRAND_ENV) scripts/release-manifest.sh
	$(BRAND_ENV) v=$$(jq -r .version dist/metadata.json) && scripts/release-sign.sh sign "$$v" dist/release && \
		scripts/release-sign.sh upload "v$$v" dist/release

e2e: ## Three VMs (Colima A/B, plain Lima C): install, join, the 40-check checklist -> test/e2e-colima/RESULTS.md (KEEP=1 keeps the VMs)
	test/e2e-colima/run.sh

e2e-checks: ## Rerun e2e checks on the kept VMs: make e2e-checks CHECKS="7 8"
	test/e2e-colima/checks.sh $(CHECKS)

e2e-refresh: ## Roll the working tree onto the kept e2e VMs (next test release, through the panel's update)
	test/e2e-colima/refresh.sh

e2e-down: ## Delete the e2e VMs and their output
	test/e2e-colima/down.sh
