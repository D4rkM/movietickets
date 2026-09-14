# Build context is the monorepo root (see docker-compose.yml), so the
# pnpm workspace files (pnpm-workspace.yaml, root package.json, lockfile)
# are visible and dependency resolution matches local dev exactly.

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/web apps/web
RUN pnpm --filter web build

# `vite preview` (the static server used below) needs `vite` itself, which is
# a devDependency — unlike the API image, we can't `deploy --prod` here, so
# the runtime stage just reuses the build stage's full node_modules instead
# of copying a pruned one.
FROM build AS runtime
ENV NODE_ENV=production
EXPOSE 5173
CMD ["pnpm", "--filter", "web", "preview"]
