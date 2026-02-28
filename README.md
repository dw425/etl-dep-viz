# ETL Dependency Visualizer

Interactive dependency visualization for ETL flows. Upload Informatica PowerCenter or Apache NiFi XML files and get 7 interactive views:

1. **Tier Diagram** — Horizontal tier bands with SVG Bezier connections
2. **Galaxy Map** — D3 orbital layout with zoom/pan and minimap
3. **Constellation** — Canvas point cloud for 15K+ sessions with 7 clustering algorithms
4. **Explorer** — Session list with detail panel (reads/writes/lookups/downstream)
5. **Conflicts & Chains** — Write-write conflicts + read-after-write ordering
6. **Execution Order** — Topological sort timeline with conflict badges
7. **Relationship Matrix** — Sessions x Tables grid with connection-type cells

## Quick Start

### Docker (recommended)

```bash
docker compose up --build
# Open http://localhost:8000
```

### Local Development

**Backend:**
```bash
cd backend
pip install -e .
uvicorn app.main:app --reload --port 8000
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
# Open http://localhost:3000
```

## Supported Platforms

- **Informatica PowerCenter** — XML exports (sessions, mappings, workflows)
- **Apache NiFi** — Flow XML and template XML files
- **Mixed uploads** — ZIP archives containing both platforms

## Architecture

- **Backend:** FastAPI + lxml + NetworkX (graph algorithms)
- **Frontend:** React 18 + TypeScript + D3.js + Tailwind CSS
- **No database, no auth** — fully stateless, public access

## Deployment

The Docker image deploys anywhere:
- Render / Railway / Fly.io
- Azure App Service
- Databricks Apps
- Any Docker host

```bash
docker build -t etl-dep-viz .
docker run -p 8000:8000 etl-dep-viz
```
