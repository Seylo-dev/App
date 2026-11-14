# The panel image: the Bun runtime plus the built panel (apps/panel/dist,
# its migrations), the web app (apps/web/dist) and the template catalog
# (templates/). Nothing is compiled here:
# `make panel-image` (and goreleaser) build the TypeScript first and this
# file only packages it, so the image is the same on every builder.
#
# Brand values come in as build args from installer/brand.env (the
# Makefile passes them), so a white-label build changes no file here.
#
#   make build-ts && docker build -f deploy/panel.Dockerfile \
#     --build-arg VERSION=0.1.0 --build-arg ENV_PREFIX=SEYLO --build-arg DATA_DIR=/var/lib/seylo .

# Pinned by the multi-arch index digest, so a re-pushed tag cannot change a
# release build. To move to a new Bun: `docker buildx imagetools inspect
# oven/bun:<version>-slim` and copy its Digest here.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

ARG VERSION=dev
# Upper-case brand slug: the panel reads <ENV_PREFIX>_* variables.
ARG ENV_PREFIX=SEYLO
# Node data dir; the panel keeps panel.db, metrics.db and master.key in
# <DATA_DIR>/panel, which the agent mounts from the host.
ARG DATA_DIR=/var/lib/seylo
ARG REVISION=unknown
# The panel user (go/internal/docker PanelUID; a test checks they match):
# no login user has it, so none can read master.key or panel.db.
ARG PANEL_UID=61000

LABEL org.opencontainers.image.title="panel" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

ENV NODE_ENV=production \
    ${ENV_PREFIX}_VERSION=${VERSION} \
    ${ENV_PREFIX}_DATA_DIR=${DATA_DIR}/panel \
    ${ENV_PREFIX}_PORT=3000

WORKDIR /app
# Paths mirror the repository so the panel's defaults (web app and
# migrations next to apps/panel) work unchanged.
COPY apps/panel/package.json apps/panel/package.json
COPY apps/panel/dist apps/panel/dist
COPY apps/panel/drizzle apps/panel/drizzle
COPY apps/web/dist apps/web/dist
# The template catalog the panel ships (templates/catalog.json, its
# signature and the logos' NOTICE, vendored by scripts/sync-templates.ts),
# read at runtime next to the bundle (modules/templates/catalog.ts catalogDir()).
COPY templates templates

# The panel user runs the panel. The data folder is a bind mount the agent
# gives to that user (mode 0700) and starts the container with --user
# ${PANEL_UID}:${PANEL_UID}. There is no USER line: started as root (an
# agent from before the panel user, or `docker run` by hand) the entrypoint
# runs the panel as the folder's owner and never as root
# (deploy/panel-entrypoint.sh). The base image's uid 1000 ("bun") is the
# default login user on most cloud images and is not used.
COPY deploy/panel-entrypoint.sh /usr/local/bin/panel-entrypoint
RUN sed -i -e "s|@@PANEL_UID@@|${PANEL_UID}|g" -e "s|@@ENV_PREFIX@@|${ENV_PREFIX}|g" -e "s|@@DATA_DIR@@|${DATA_DIR}|g" \
      /usr/local/bin/panel-entrypoint && chmod 0755 /usr/local/bin/panel-entrypoint && \
    mkdir -p "${DATA_DIR}/panel" && chown -R "${PANEL_UID}:${PANEL_UID}" "${DATA_DIR}/panel" && chmod 0700 "${DATA_DIR}/panel"

EXPOSE 3000
VOLUME ["${DATA_DIR}/panel"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/panel-entrypoint"]
CMD ["bun", "apps/panel/dist/main.js"]
