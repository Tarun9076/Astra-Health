# ASTRA HEALTH — prototype evaluation

Generated 2026-11-14T20:29:26+00:00 by `python -m astra.evaluate` (services/backend). Data: simulated ARES-1 mission, seed 42, 150 days (30 pre-flight + 120 in flight), 3 crew.
**Simulated data only — engineering metrics of the prototype, not clinical performance.**

## Scenario detection

| Scenario | Injected | Detected | Time to detection |
|---|---|---|---|
| Fatigue episode (AST-001) | day 114, ramping over 5 days | rule alerts from day 116 (BEH-FATIGUE-COMPOSITE, CV-RHR-BASELINE, ML-ANOMALY-CORROBORATED); AI trend insight day 115 | 2 days (trend: 1) |
| Solar particle event (real May 2024 DONKI replay) | day 87 | Urgent RAD-SPE-EVENT for 3/3 crew | same day |
| Sensor glitch (HR 190, low signal, AST-002) | day 60 | reading marked Questionable; 0 alerts | correctly not alarmed |

Detection rate: **2/2** injected episodes; median time to detection **1.0 days**.

## False alarms — same crew, no injected events (budget ≤ 2 Attention, 0 Urgent per astronaut)

| Astronaut | Attention | Urgent | Rules |
|---|---|---|---|
| AST-001 | 1 | 0 | SLP-DEFICIT |
| AST-002 | 1 | 0 | CV-RHR-BASELINE |
| AST-003 | 2 | 0 | CV-RHR-BASELINE, SLP-DEFICIT |

AI insights for the healthy crew: 0 trend, 20 anomaly (advisory notes, no alerts).

## API response time

| Endpoint (150 days × 3 crew) | Median |
|---|---|
| dashboard | 47 ms |
| body systems | 49 ms |
| analytics mission | 52 ms |
| crew summary | 270 ms |
| report 7d | 64 ms |

Other measured results are in the implementation plan (Steps 4–9): check-in completed in 38 s in the browser; sync delivered every item exactly once (re-sent envelopes are no-ops, T-S-01); alerts reached Earth 24.4 s after link-up with a 22 s simulated light time.
