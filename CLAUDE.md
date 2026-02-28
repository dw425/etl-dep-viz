# ETL Dependency Visualizer — Developer Guide

## Project Structure

```
etl-dep-viz/
├── backend/             # FastAPI + Python data science
│   ├── app/
│   │   ├── config.py           # Pydantic settings (EDV_ env prefix)
│   │   ├── main.py             # FastAPI app, middleware, router mounts
│   │   ├── models/             # SQLAlchemy models (Upload, ActiveTag)
│   │   ├── routers/            # API endpoints (tier_map, vectors, layers, active_tags)
│   │   ├── engines/            # Parse engines (Informatica, NiFi)
│   │   │   └── vectors/        # 11 analysis vector engines (V1-V11) + orchestrator
│   │   ├── platform/           # Platform capability flags
│   │   └── utils/              # Custom exceptions
│   ├── tests/                  # pytest tests
│   └── pyproject.toml
├── frontend/            # React + TypeScript + D3 + Vite
│   └── src/
│       ├── api/client.ts       # API client functions
│       ├── components/tiermap/ # Main views (23 components)
│       ├── layers/             # L1-L6 progressive disclosure
│       ├── navigation/         # Breadcrumb, context, search
│       └── types/              # TypeScript interfaces
├── Dockerfile           # Two-stage build (Node → Python)
└── docker-compose.yml
```

## Quick Commands

```bash
# Backend
cd backend && pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000
pytest -v
pytest --cov=app --cov-report=term-missing

# Frontend
cd frontend && npm install
npm run dev          # dev server on :3000, proxies /api to :8000
npx vitest run       # tests
npx vitest run --coverage

# Docker
docker compose up --build
```

## Conventions

- **Python**: snake_case, type hints, pydantic models for config
- **TypeScript**: camelCase, interfaces in `types/`, functional components
- **API**: All endpoints prefixed `/api/`, JSON responses, SSE for streaming
- **DB**: SQLAlchemy ORM, SQLite default, JSON blobs for complex data
- **Tests**: pytest (backend), vitest (frontend), fixtures in `tests/fixtures/`
- **Naming**: Vector engines = V1-V11, Layers = L1-L6

## Architecture Notes

- Tier data flows: Upload → Parse (Infa/NiFi) → Tier Assignment → Constellation Clustering → Vector Analysis
- Vector orchestrator runs in 3 phases: Core (V1,V4,V11) → Advanced (V2,V3,V9,V10) → Ensemble (V5-V8)
- Frontend uses 15-tab view system + 6-layer progressive drill-down
- SSE streaming for long operations (constellation, vector analysis)
- All parsed data persisted to SQLite (Upload model) for reload without re-parsing
