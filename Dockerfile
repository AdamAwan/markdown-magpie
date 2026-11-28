FROM node:22-bookworm-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY apps/watcher/package.json apps/watcher/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/git/package.json packages/git/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/markdown/package.json packages/markdown/package.json
COPY packages/retrieval/package.json packages/retrieval/package.json

RUN npm ci

FROM deps AS build

COPY tsconfig.base.json tsconfig.check.json ./
COPY apps apps
COPY knowledge-bases knowledge-bases
COPY packages packages
COPY scripts scripts

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# tini is PID 1 (see ENTRYPOINT): it forwards SIGTERM to the node process and
# reaps the git / provider-CLI children the watcher spawns.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps apps
COPY --from=build /app/knowledge-bases knowledge-bases
COPY --from=build /app/packages packages
COPY --from=build /app/scripts scripts
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json

# Run as a non-root user. Create the checkout and snapshot roots owned by that user
# so fresh named volumes mounted there inherit writable ownership (Docker seeds an
# empty volume from the image mountpoint's ownership on first use).
RUN groupadd --system --gid 1001 magpie \
  && useradd --system --uid 1001 --gid magpie --no-create-home magpie \
  && mkdir -p /data/checkouts /data/snapshots \
  && chown -R magpie:magpie /data
USER magpie

# Build identity, surfaced by the API at GET /api/version. Declared this late so
# the per-commit values don't invalidate the cached dependency/COPY layers above.
# Populated by .github/workflows/publish-image.yml; absent in local builds, where
# the endpoint falls back to a "dev" build.
ARG GIT_SHA=""
ARG GIT_COMMIT_MESSAGE=""
ARG GIT_COMMITTED_AT=""
ENV MAGPIE_BUILD_SHA=$GIT_SHA
ENV MAGPIE_BUILD_COMMIT_MESSAGE=$GIT_COMMIT_MESSAGE
ENV MAGPIE_BUILD_COMMITTED_AT=$GIT_COMMITTED_AT

EXPOSE 3000 4000 4001

# Signals must reach node, which drains in-flight work on SIGTERM (docs/api.md
# API37, docs/ai-jobs.md J53/J54). So no `npm run start` and no shell: npm does
# not reliably forward SIGTERM to its child, and node as PID 1 would get no
# default signal handling and leave zombies. tini (PID 1) execs node directly and
# forwards the signal to it alone — deliberately not to the process group
# (`tini -g`), so a provider CLI the watcher is running is wound down by the
# watcher's own abort, not killed out from under it. The workdir stays /app: the
# API resolves relative KNOWLEDGE_* / data paths against it, as it did when npm
# ran it from the repo root. Override CMD (exec form) to run another app.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]
