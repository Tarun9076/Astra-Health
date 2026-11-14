# Protocols

Medical "knowledge as data", loaded and cross-checked by the backend at startup (`astra/core/protocols.py`). If any file is invalid, the backend refuses to start and lists every problem with its file name. Every rule carries an `id` and a semantic `version`, and each alert records the rule version that fired it.

| Path | Contents | Status |
|---|---|---|
| `indicators.json` | 22 indicators: units, conversions, plausible ranges, spread floors (LLD §2) | ✅ Step 1 |
| `rules/*.json` | Rules in the JSON rule format (LLD §6.1); file name = rule id | ✅ 6 starter rules (Step 1); the rest in Step 5 |
| `recommendations.json` | 15 actions linked from rules and the daily routine (LLD §8) | ✅ Step 1 |
| `emergency/EMG-*.md` | 5 step-by-step emergency procedures (YAML front matter + Markdown), shown offline | ✅ Step 1 |
| `mission-profiles/*.json` | Gravity, comms delay, radiation limit, exercise and hydration targets | ✅ `mars-surface.json` |

## Editing a rule

1. Change the JSON file and bump its `version` (e.g. `1.0.0` → `1.1.0`).
2. Run the backend tests. They load these exact files and fail with a clear message if something is wrong:
   ```bash
   cd services/backend && .venv/Scripts/python -m pytest tests/core/test_protocols.py
   ```

⚠️ All thresholds and procedures here are **illustrative** placeholders, not clinical values or approved medical procedures.
