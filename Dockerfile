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

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps apps
COPY --from=build /app/knowledge-bases knowledge-bases
COPY --from=build /app/packages packages
COPY --from=build /app/scripts scripts
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json

EXPOSE 3000 4000 4001

CMD ["npm", "run", "start", "-w", "@magpie/api"]
