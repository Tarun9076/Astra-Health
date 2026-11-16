# Protocols

Medical "knowledge as data", loaded and cross-checked by the backend at startup (`astra/core/protocols.py`). If any file is invalid, the backend refuses to start and lists every problem with its file name. Every rule carries an `id` and a semantic `version`, and each alert records the rule version that fired it.

| Path | Contents | Status |
|---|---|---|
| `indicators.json` | 22 indicators: units, conversions, plausible ranges, spread floors (LLD §2) | ✅ Step 1 |
| `rules/*.json` | Rules in the JSON rule format (LLD §6.1); file name = rule id | ✅ 19 rules (Steps 1, 5, 6, 10) |
| `recommendations.json` | 22 actions linked from rules and the daily routine (LLD §8) | ✅ Steps 1, 5, 10 |
| `emergency/EMG-*.md` | 11 step-by-step emergency procedures (YAML front matter + Markdown), shown offline and bundled into the web app | ✅ Steps 1, 5, 7 |
| `redflags.yaml` | Red-flag phrases for the AI assistant → emergency procedure (negations, hypothetical questions) | ✅ Step 7 |
| `treatments/TX-*.json` | Act Now (Step 21): 7 critical treatment protocols (triggers, steps with exact doses, rechecks with timers and repeat limits, "do not give" rules, escalation). **Demo** | ✅ Step 21 |
| `treatments/routine.json` | Mild/moderate check-in symptoms and alerts → Medication Guide conditions | ✅ Step 21 |
| `treatments/cases.json` | 32 clinical test cases run against the backend engine **and** the on-device engine | ✅ Step 21 |
| `medications.json` | Medication Guide (Step 20) and emergency kit (Step 21): 9 kit medicines (dose, interval, 24-hour and day limits, allergy groups, conditions to avoid, interactions, stock, expiry, label source) and 10 conditions (safety questions, things to try first, medicines in order). **Demo values from US OTC labels, not approved by a flight surgeon** | ✅ Step 20 |
| `mission-profiles/*.json` | Environment, gravity, comms delay, evacuation, radiation limit, exercise and hydration targets, health focus | ✅ `iss-leo`, `mars-transit`, `lunar-rover`, `mars-surface` (default) |

## Editing a rule

1. Change the JSON file and bump its `version` (e.g. `1.0.0` → `1.1.0`).
2. Run the backend tests. They load these exact files and fail with a clear message if something is wrong:
   ```bash
   cd services/backend && .venv/Scripts/python -m pytest tests/core/test_protocols.py
   ```

⚠️ All thresholds and procedures here are **illustrative** placeholders, not clinical values or approved medical procedures.
