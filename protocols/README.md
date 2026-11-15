# Protocols

Medical "knowledge as data", loaded and cross-checked by the backend at startup (`astra/core/protocols.py`). If any file is invalid, the backend refuses to start and lists every problem with its file name. Every rule carries an `id` and a semantic `version`, and each alert records the rule version that fired it.

| Path | Contents | Status |
|---|---|---|
| `indicators.json` | 22 indicators: units, conversions, plausible ranges, spread floors (LLD §2) | ✅ Step 1 |
| `rules/*.json` | Rules in the JSON rule format (LLD §6.1); file name = rule id | ✅ 19 rules (Steps 1, 5, 6, 10) |
| `recommendations.json` | 22 actions linked from rules and the daily routine (LLD §8) | ✅ Steps 1, 5, 10 |
| `emergency/EMG-*.md` | 10 step-by-step emergency procedures (YAML front matter + Markdown), shown offline and bundled into the web app | ✅ Steps 1, 5, 7 |
| `redflags.yaml` | Red-flag phrases for the AI assistant → emergency procedure (negations, hypothetical questions) | ✅ Step 7 |
| `mission-profiles/*.json` | Environment, gravity, comms delay, evacuation, radiation limit, exercise and hydration targets, health focus | ✅ `iss-leo`, `mars-transit`, `lunar-rover`, `mars-surface` (default) |

## Editing a rule

1. Change the JSON file and bump its `version` (e.g. `1.0.0` → `1.1.0`).
2. Run the backend tests. They load these exact files and fail with a clear message if something is wrong:
   ```bash
   cd services/backend && .venv/Scripts/python -m pytest tests/core/test_protocols.py
   ```

⚠️ All thresholds and procedures here are **illustrative** placeholders, not clinical values or approved medical procedures.
