# Pipeline Analyzer — Development & Deployment Automation
# Usage: make <target>

.PHONY: help dev test build deploy stop start restart logs migrate coverage lint clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── Development ──────────────────────────────────────────────────────────

dev: ## Start backend + frontend dev servers
	@echo "Starting backend on :8000 and frontend on :3000..."
	cd backend && uvicorn app.main:app --reload --port 8000 &
	cd frontend && npm run dev &
	wait

backend: ## Start backend only
	cd backend && uvicorn app.main:app --reload --port 8000

frontend: ## Start frontend only
	cd frontend && npm run dev

# ── Testing ──────────────────────────────────────────────────────────────

test: ## Run all backend tests
	cd backend && python3 -m pytest -v

test-quick: ## Run tests without slow markers
	cd backend && python3 -m pytest -v -m "not slow"

coverage: ## Run tests with coverage report
	cd backend && python3 -m pytest --cov=app --cov-report=term-missing

typecheck: ## TypeScript type check (frontend)
	cd frontend && npx tsc --noEmit

lint: ## Run all checks (tests + typecheck + build)
	@echo "=== Backend Tests ===" && cd backend && python3 -m pytest -v
	@echo "=== TypeScript Check ===" && cd frontend && npx tsc --noEmit
	@echo "=== Vite Build ===" && cd frontend && npx vite build
	@echo "All checks passed."

# ── Build ────────────────────────────────────────────────────────────────

build: ## Build frontend for production
	cd frontend && npx vite build

docker: ## Build Docker image
	docker compose up --build

# ── Databricks Deployment ────────────────────────────────────────────────

deploy: ## Sync code and deploy to Databricks
	databricks sync . /Workspace/Users/$(shell databricks current-user me --output json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('userName',''))")/etl-dep-viz --watch=false
	databricks apps deploy etl-dep-viz

stop: ## Stop Databricks app
	databricks apps stop etl-dep-viz

start: ## Start Databricks app
	databricks apps start etl-dep-viz

restart: stop start ## Restart Databricks app

logs: ## Tail Databricks app logs
	databricks apps get-logs etl-dep-viz --follow

status: ## Check Databricks app status
	databricks apps get etl-dep-viz

# ── Database ─────────────────────────────────────────────────────────────

migrate: ## Upload SQLite DB to Lakebase
	@echo "Upload SQLite file to running app: curl -X POST -F 'file=@backend/etl_dep_viz.db' <APP_URL>/api/admin/migrate-sqlite"

# ── Cleanup ──────────────────────────────────────────────────────────────

clean: ## Remove build artifacts and caches
	rm -rf frontend/dist frontend/node_modules/.vite
	find backend -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find backend -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
