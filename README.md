# ASTRA HEALTH

**Autonomous Astronaut Health Intelligence & Decision-Support Platform** — a hackathon prototype that turns raw astronaut health measurements into explainable, actionable guidance that works onboard and offline, and forwards reports to flight surgeons on Earth.

> ⚠️ **Not a medical device.** Research/hackathon prototype for clinical *decision support* only. It does not diagnose or prescribe. All thresholds are **illustrative**; all demo data is **simulated**.

## Repository layout

```
apps/web/                React + Vite + TypeScript + Tailwind PWA (astronaut, surgeon, mission, admin)
services/backend/        Python 3.12 FastAPI backend (package `astra`): ingestion, baselines, rules, alerts,
                         ML insights, AI assistant (RAG), WebSockets, Habitat↔Ground sync
simulator/               Simulated crew data generator (YAML scenarios)
protocols/               Indicator catalog, versioned rules, recommendations, emergency procedures
knowledge/               Curated knowledge base (NASA/CSA-sourced notes) for the assistant
docs/                    TDD, HLD, LLD, Implementation Plan (Markdown + PDF in docs/pdf/)
tools/docs-pdf/          Regenerates the doc PDFs
```

Design docs: start at [docs/README.md](docs/README.md). Build order: [docs/04-Implementation-Plan.md](docs/04-Implementation-Plan.md).
PDF versions are in `docs/pdf/` (`ASTRA-HEALTH-Design-Docs.pdf` is the complete set). After editing any doc, regenerate them with `cd tools/docs-pdf && npm install && npm run pdf`.

## Prerequisites

Python 3.12 (via [uv](https://docs.astral.sh/uv/)) · Node.js 22+ · Git

## First-time setup

```bash
cd services/backend && uv venv --python 3.12 .venv && uv pip install --python .venv/Scripts/python.exe -e ".[dev]"
```

```bash
cd apps/web && npm install
```

**Secrets:** the backend reads `services/backend/.env` (git-ignored). If it's missing, copy `services/backend/.env.example` to `.env`, then set:
- `ASTRA_JWT_SECRET`: a random value
- `ASTRA_NASA_API_KEY`: a free key from https://api.nasa.gov/
- `ANTHROPIC_API_KEY`: optional

The app runs without any keys; it then uses cached data and offline answers.

## Data

Crew health data is **simulated**, because real astronaut medical data is not public. The simulator is calibrated with published spaceflight values. The space environment uses **real data**:
- NASA DONKI solar-particle events (needs the NASA key)
- JPL Horizons Earth–Mars light time (no key)
- NOAA SWPC proton flux (no key)

Responses are cached in `simulator/fixtures/` so the demo works offline. Details: [docs/03-Low-Level-Design.md](docs/03-Low-Level-Design.md) §20.

## Run locally

**Backend, Habitat node** — Swagger UI at http://localhost:8000/docs

```bash
cd services/backend && .venv/Scripts/python -m uvicorn astra.main:app --reload --port 8000
```

**Load demo data** (once, while the backend is running). First create the mission, crew and demo accounts (from `services/backend/seed.example.json`):

```bash
cd services/backend && .venv/Scripts/python -m astra.seed
```

Then post 150 days of simulated crew data (about 6,600 readings, including the real May 2024 solar storm replay). Running it again is safe; duplicates are skipped:

```bash
services/backend/.venv/Scripts/python simulator/simulate.py seed
```

The database is `services/backend/habitat.db` (git-ignored). There are no migrations yet, so after pulling changes to the tables, stop the backend, delete `habitat.db*`, and run the two commands above again.

**Demo accounts** (from `services/backend/seed.example.json`, local demo only):

| Username | Password | Role |
|---|---|---|
| `ast1` / `ast2` / `ast3` | `astra-demo-ast1` / `-ast2` / `-ast3` | Astronaut (AST-001 / 002 / 003) |
| `surgeon1` | `astra-demo-surgeon` | Flight surgeon |
| `mission1` | `astra-demo-mission` | Mission control |
| `admin` | `astra-demo-admin` | Demo operator (simulator) |

To try the API in Swagger (http://localhost:8000/docs):
1. Call `POST /api/auth/login`.
2. Copy the `accessToken`.
3. Click **Authorize** and paste it.
4. Try `GET /api/astronauts/AST-001/dashboard`.

**Web app** — http://localhost:5173 (proxies `/api` and `/ws` to port 8000). Sign in with a demo account, e.g. `ast1`, then press **Start daily check-in**. Low sleep plus high fatigue and resting heart rate raise the fatigue alerts live.

```bash
cd apps/web && npm run dev
```

The Ground node (port 8001) is added in Step 9 of the plan; it is the same backend started with `ASTRA_NODE_ROLE=Ground`.

**Demo on any date:** delete `habitat.db*`, start the backend, then load the data:

```bash
cd services/backend && .venv/Scripts/python -m astra.seed --mission-day-today 121
```

```bash
services/backend/.venv/Scripts/python simulator/simulate.py seed
```

History is loaded up to yesterday, and past alerts are closed by the simulated flight surgeon, so today's check-in raises alerts live.

**After changing backend endpoints**, regenerate the web app's API types:

```bash
cd services/backend && .venv/Scripts/python -m astra.export_openapi ../../apps/web/openapi.json
```

```bash
cd apps/web && npm run gen:api
```

## Tests and checks

```bash
cd services/backend && .venv/Scripts/python -m pytest
```

```bash
cd services/backend && .venv/Scripts/python -m ruff check astra tests && .venv/Scripts/python -m mypy
```

```bash
cd apps/web && npm run build
```

## Sources

Hackathon-provided:
- NASA HRP — 5 Hazards of Human Spaceflight — https://www.nasa.gov/hrp/hazards/
- NASA HRP — Risks of Human Spaceflight — http://nasa.gov/hrp/risks/
- NASA HRP — Ongoing HRP Research — https://www.nasa.gov/hrp/ongoing-hrp-research/
- CSA — Monitoring radiation for astronaut health — https://www.asc-csa.gc.ca/eng/news/articles/2026/2026-02-26-monitoring-radiation-astronaut-health.asp
- CSA — Why do we conduct science experiments in space? — https://www.asc-csa.gc.ca/eng/iss/science/why-do-we-conduct-science-experiments-in-space.asp

Supporting: NASA Human Research Roadmap — https://humanresearchroadmap.nasa.gov/ · NASA-STD-3001 — https://www.nasa.gov/ocho/std-3001/
