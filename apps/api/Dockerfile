# Build context is the monorepo root (see docker-compose.yml), so the
# pnpm workspace files (pnpm-workspace.yaml, root package.json, lockfile)
# are visible and dependency resolution matches local dev exactly.

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/api apps/api
RUN pnpm --filter api build
RUN pnpm --filter api deploy --prod /prod/api

# Drizzle Studio needs drizzle-kit (devDependency, pruned in the runtime
# stage below) plus the schema/config sources — built from `deps` instead of
# `build` so it skips the Nest build it doesn't need.
FROM deps AS studio
COPY apps/api apps/api
EXPOSE 4983
CMD ["pnpm", "--filter", "api", "db:studio"]

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /prod/api/dist ./dist
COPY --from=build /prod/api/drizzle ./drizzle
COPY --from=build /prod/api/node_modules ./node_modules
COPY --from=build /prod/api/package.json ./package.json

EXPOSE 3000
# Single-container demo/dev setup, so running migrate+seed on boot is safe (no
# concurrent instances racing on it, and seed.ts is idempotent — safe to run
# again on every restart). Don't do this for a multi-instance production
# deploy — run migrations/seeding as a separate release step instead.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/db/seed.js && node dist/main.js"]
