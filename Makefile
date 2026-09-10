.DEFAULT_GOAL := help

# `docker` may only exist as a shell alias (e.g. to podman) on the developer's
# machine — Make always runs recipes through a non-interactive shell, which
# doesn't source shell rc files, so a plain `docker` alias is invisible here.
# Fall back to a real `podman` binary when a real `docker` binary isn't found.
DOCKER := $(shell command -v docker 2>/dev/null || command -v podman 2>/dev/null || echo docker)

.PHONY: help up down up-full down-full install migrate seed dev-api dev-web build lint test test-integration

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'

up: ## Start local infra (Postgres + Valkey) via docker/podman compose
	$(DOCKER) compose up -d

down: ## Stop local infra
	$(DOCKER) compose down

up-full: ## Start the whole stack containerized (infra + api), no Node/pnpm needed on the host
	$(DOCKER) compose --profile full up -d --build

down-full: ## Stop the whole containerized stack
	$(DOCKER) compose --profile full down

install: ## Install workspace dependencies
	pnpm install

migrate: ## Apply Drizzle migrations to the local Postgres
	pnpm --filter api db:migrate

seed: ## Seed the local Postgres with dev users
	pnpm --filter api db:seed

dev-api: ## Run apps/api in watch mode
	pnpm dev:api

dev-web: ## Run apps/web in dev mode
	pnpm dev:web

build: ## Build all workspace packages
	pnpm build

lint: ## Lint all workspace packages
	pnpm lint

test: ## Run unit tests (apps/api)
	pnpm --filter api test

test-integration: ## Run integration tests against the local Postgres
	pnpm --filter api test:integration
