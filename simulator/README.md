# Simulator

Generates calibrated, clearly labelled **SIMULATED** crew health data and posts it through the real intake API. The generator code is in `services/backend/astra/simulation/`; this folder holds the command-line tool, the scenarios and the cached real data.

Run from the repo root with the backend's virtual environment, while the backend is running on port 8000:

```bash
services/backend/.venv/Scripts/python simulator/simulate.py seed
```

```bash
services/backend/.venv/Scripts/python simulator/simulate.py preview --astronaut AST-001 --indicator resting_hr
```

```bash
services/backend/.venv/Scripts/python simulator/simulate.py fixtures
```

| Command | What it does |
|---|---|
| `seed` | Signs in as the demo admin, takes the mission start date from the backend, and posts pre-flight plus mission history **up to yesterday** for AST-001..003 (about 6,600 readings). It then signs in as the flight surgeon and closes all past alerts (`--close-before-day N` to keep later ones open, `0` to keep all), so today's check-in raises alerts live. Safe to re-run: duplicates are skipped. `--dry-run` only counts |
| `preview` | Prints the last generated values for one astronaut and indicator, without the backend |
| `fixtures` | Re-downloads the real data below (needs `ASTRA_NASA_API_KEY` in `services/backend/.env`) |

**Before the first `seed`:** create the mission and accounts once with `python -m astra.seed` (run in `services/backend`).

## What's in the data

`scenarios/crew.yaml` lists every calibration value next to its published source.

- **Different personal normals:** AST-002 has a low resting heart rate (55 bpm) and AST-003 a high one (80 bpm), so the same 85 bpm means different things.
- **In-flight sleep** is about 0.6 h shorter than pre-flight.
- **Mars-surface radiation** is about 0.64 mSv/day, with a 30 % neutron channel.
- **Fatigue story:** from day 114, AST-001's sleep drops to about 4 h, resting heart rate rises to about 90 bpm, and fatigue and stress go up.
- **Real solar storm:** the May 2024 storm (NASA DONKI) is replayed from day 87, giving radiation spikes on days 87, 88, 89 and 91.
- **Sensor glitch:** a 190 bpm reading with poor signal on day 60 (AST-002), which must be marked Questionable and never raise an alert.

## Real data (`fixtures/`)

| File | Source |
|---|---|
| `donki-sep-2024-05.json` | NASA DONKI solar energetic particle events, May 2024 (14 events) |
| `horizons-mars-2026-07-to-11.json` | JPL Horizons Earth–Mars distance and one-way light time, 17 Jul – 14 Nov 2026 (17.1 → 11.0 min) |

The API key is never written to these files.
