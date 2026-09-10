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

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /prod/api/dist ./dist
COPY --from=build /prod/api/drizzle ./drizzle
COPY --from=build /prod/api/node_modules ./node_modules
COPY --from=build /prod/api/package.json ./package.json

EXPOSE 3000
# Single-container demo/dev setup, so running the migration on boot is safe
# (no concurrent instances racing on it). Don't do this for a multi-instance
# production deploy — run migrations as a separate release step instead.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/main.js"]
