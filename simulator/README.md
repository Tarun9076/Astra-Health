# Simulator

Generates simulated crew health data and posts it through the real ingestion API (Step 2 of the implementation plan).

Planned CLI (`simulate.py`, built in Step 2):

```bash
python simulate.py seed --scenario scenarios/crew.yaml --api http://localhost:8000
```

```bash
python simulate.py stream --astronaut AST-001 --every 5s
```

```bash
python simulate.py inject --scenario fatigue_onset --astronaut AST-001 --day 114
```

Run it with the backend virtual environment (`services/backend/.venv`) (it already has numpy, httpx and pyyaml); add `typer` there when you build the CLI.

`scenarios/crew.yaml` defines three astronauts with deliberately different baselines (AST-002 low resting HR, AST-003 high) for the "same number, different meaning" demo, plus the fatigue, radiation-event and sensor-glitch scenarios.
