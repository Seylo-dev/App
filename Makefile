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
	test-installer installer panel-image release-check release-snapshot release-dry-run release e2e e2e-checks e2e-refresh e2e-down

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

test: test-go test-ts test-installer ## Run Go, TypeScript and installer tests

test-go: ## Go tests with the race detector
	@for d in $(GO_DIRS); do go -C $$d test -race ./... || exit 1; done

test-ts: ## bun test in every workspace
	bun run test

test-installer: ## install.sh in --root mode against a fake signed release (skips without minisign)
	installer/test/run.sh

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

release-snapshot: ## Build the release binaries and install.sh into dist/ (no publish, sign or image)
	$(BRAND_ENV) goreleaser release --snapshot --clean --skip=sign,docker,before
	scripts/render-installer.sh latest dist/install.sh

release-dry-run: ## goreleaser as in `make release`, publishing nothing: snapshot, signed, one panel image per platform loaded locally (MINISIGN_SECRET_KEY, MINISIGN_PASSWORD)
	$(BRAND_ENV) goreleaser release --snapshot --clean

release: ## Publish from a v* tag (GITHUB_TOKEN, MINISIGN_SECRET_KEY, MINISIGN_PASSWORD, docker login)
	$(BRAND_ENV) scripts/release-preflight.sh
	$(BRAND_ENV) goreleaser release --clean
	$(BRAND_ENV) scripts/release-manifest.sh

e2e: ## Three VMs (Colima A/B, plain Lima C): install, join, the 31-check checklist -> test/e2e-colima/RESULTS.md (KEEP=1 keeps the VMs)
	test/e2e-colima/run.sh

e2e-checks: ## Rerun e2e checks on the kept VMs: make e2e-checks CHECKS="7 8"
	test/e2e-colima/checks.sh $(CHECKS)

e2e-refresh: ## Roll the working tree onto the kept e2e VMs (next test release, through the panel's update)
	test/e2e-colima/refresh.sh

e2e-down: ## Delete the e2e VMs and their output
	test/e2e-colima/down.sh
