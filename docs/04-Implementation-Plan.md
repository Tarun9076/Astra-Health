# ASTRA HEALTH — Step-by-Step Implementation Plan

**Version:** 1.1 (React + single FastAPI backend) · **Date:** 2026-11-14 · **Horizon:** 30 days (see §6 cut-lines)
**Design references:** [TDD](01-Technical-Design-Document.md) · [HLD](02-High-Level-Design.md) · [LLD](03-Low-Level-Design.md)

**Stack:** React 19 + Vite + TypeScript + Tailwind (web) · Python 3.12 + FastAPI + SQLModel/SQLite + scikit-learn + Anthropic SDK (backend) · FastAPI WebSockets (real-time). Why this stack: TDD ADR-13.

---

## 1. The build philosophy (read this once)

1. **Build the brain first, then the face.** The heart of ASTRA HEALTH is *simulated data → validation → personal baseline → rules → explainable alert*. That's pure Python in `astra.core` that you can unit-test on Day 2 without any UI. Every screen afterwards just displays it.
2. **Vertical slices, not layers.** Each step below ends with something that works end-to-end and could be demoed. You find integration problems on Day 9, not Day 25.
3. **Simulated data from Day 1.** Analytics need history. The simulator is the foundation of every test and of the demo.
4. **Always have a demoable build.** Tag each milestone (`git tag m1-health-brain`). If Day 30 goes wrong, you present the last tag.
5. **Keep `astra.core` pure.** No FastAPI, database or network imports there. This is what keeps the safety logic testable and trustworthy.
6. **Safety language everywhere.** "Illustrative thresholds", "SIMULATED", "not a diagnosis", from the first screen.

---

## 2. Milestones at a glance

| Milestone | Day | What you can demo |
|---|---|---|
| **M0 — Repo ready** ✅ | 1 | Monorepo scaffolded: FastAPI backend + React shell run together; tests pass |
| **M1 — Health brain** ✅ | 6 | 120 days of simulated crew data in SQLite; baselines + rules produce the right alerts in unit/scenario tests; Swagger UI shows them |
| **M2 — Walking skeleton** ✅ | 10 | Log in as astronaut → Overview → do a check-in → alert appears live (WebSocket) with explanation |
| **M3 — Insightful** | 15 | Analytics charts with baseline bands; recommendations; ML anomaly/trend insights |
| **M4 — Assistant** | 18 | Chat with citations; red-flag emergency card; works with *and* without internet |
| **M5 — Earth link** | 23 | Surgeon dashboard on the Ground node; blackout + delay; reports arrive late but exactly once; instructions flow back |
| **M6 — Wow layer** | 26 | Body Explorer (3D), Wellness Center, radiation & environment panel |
| **M7 — Demo-ready** | 30 | Hardened, scenario-tested, rehearsed 5-minute demo, backup video, README |

```mermaid
gantt
    title ASTRA HEALTH — 30-day plan (FastAPI stack)
    dateFormat  YYYY-MM-DD
    axisFormat  %d %b
    section Foundation
    Step 0 Scaffold (done)               :done, s0, 2026-11-14, 1d
    Step 1 Catalog, protocols, core models :done, s1, after s0, 1d
    Step 2 DB, simulator, ingestion      :done, s2, after s1, 2d
    Step 3 Baselines, rules, alerts, auth :done, s3, after s2, 2d
    section Product
    Step 4 Dashboard, check-in, live alerts :done, s4, after s3, 4d
    Step 5 Analytics, recommendations, wellness :done, s5, after s4, 2d
    Step 6 ML insights                   :done, s6, after s5, 3d
    Step 7 AI assistant + RAG            :done, s7, after s6, 3d
    section Earth and wow
    Step 8 Reports + surgeon dashboard   :done, s8, after s7, 2d
    Step 9 Offline, Ground node, link sim :done, s9, after s8, 3d
    Step 10 Body Explorer, wellness, env :done, s10, after s9, 3d
    section Ship
    Step 11 Hardening and tests          :done, s11, after s10, 3d
    Step 12 Demo and pitch               :s12, after s11, 2d
```

---

## 3. Step-by-step plan

Each step: **Goal → Tasks → Done when.** File paths refer to the LLD §1 layout (`services/backend/astra/...`, `apps/web/src/...`).

---

### Step 0 — Scaffold ✅ (done on Day 1)

Already in the repo:
- `services/backend/`: FastAPI app `astra` with `/api/system/status`, `/health`, the `/ws` WebSocket hub, settings via `ASTRA_*` env vars, `astra.core.enums`, pytest suite (incl. the "core stays pure" test).
- `apps/web/`: React + Vite + Tailwind shell, 7-section navigation, live node-status pill, SIMULATED badge; Vite proxies `/api` and `/ws` to the backend.
- `protocols/`, `simulator/scenarios/crew.yaml`, `knowledge/`, CI workflow, PDF generator for docs.

Also done: `services/backend/.env` (git-ignored) with a random `ASTRA_JWT_SECRET` and empty slots for `ASTRA_NASA_API_KEY` and `ANTHROPIC_API_KEY`; `.env.example` is the committed template.

**Your remaining Day-1 tasks:**
- Get a free NASA API key at https://api.nasa.gov/ ("Generate API Key"). Paste it into `ASTRA_NASA_API_KEY` in `services/backend/.env`.
- Make the first commit, create the GitHub repo and push (CI runs automatically). Check that `.env` is not staged.
- Agree on team ownership (§4).

---

### Step 1 — Indicator catalog, protocols and core models (Day 2) ✅

**Goal:** encode the medical "knowledge" as data, with typed loaders, before writing logic.

**Tasks**
- [x] `protocols/indicators.json` — the indicators in LLD §2 (units, conversions, plausible ranges, σ floors).
- [x] `protocols/rules/*.json` — start with **6 rules**: `CV-RHR-BASELINE`, `TH-FEVER`, `TH-FEVER-HIGH`, `SLP-DEFICIT`, `BEH-FATIGUE-COMPOSITE`, `RAD-SPE-EVENT`.
- [x] `protocols/recommendations.json` (~15 entries) and `protocols/emergency/EMG-*.md` (chest pain, syncope, fever, radiation shelter, behavioral crisis — marked illustrative).
- [x] `astra/core/indicators.py`: Pydantic models + loader + `to_canonical(value, unit)`.
- [x] `astra/core/rules/models.py` + `loader.py`: the rule DSL as Pydantic models (LLD §6.4); startup validation of unknown indicators, ops and recommendation codes.
- [x] Load everything in the app's `lifespan` and expose counts on `/health`.
- [x] Tests: T-V-01, T-V-02 (unit conversion), T-R-07 (bad rule file fails).

**Done when:** `pytest` passes and `/health` shows `"indicators": 22, "rules": 6, "recommendations": 15, "emergencyProtocols": 5`. **Done 2026-11-14: 45 backend tests pass; ruff and strict mypy clean.**

---

### Step 2 — Database, simulator, ingestion API (Days 3–4) ✅

**Goal:** realistic history in a real database through the real API.

**Tasks**
- [x] `astra/db/models.py`: SQLModel tables for Users, Missions, Astronauts, HealthMeasurements, WellnessCheckins, Symptoms, HealthBaselines, HealthAlerts, Recommendations, AuditLog, SyncOutbox (LLD §3). `astra/db/session.py` with a `get_session` dependency.
- [ ] *Deferred to before Step 9:* Alembic migrations. Step 2 uses `SQLModel.metadata.create_all` (tables are created at startup).
- [x] Seed command (`python -m astra.seed`): mission ARES-1, AST-001/002/003, users `ast1/ast2/ast3`, `surgeon1`, `mission1`, `admin` (demo passwords in `seed.example.json`, the real file git-ignored).
- [x] `astra/core/validation.py` (LLD §4) + tests T-V-03..05.
- [x] Routers: `POST /api/measurements/batch`, `GET /api/astronauts/{id}/measurements?bucket=day` (pandas resampling for buckets).
- [x] `simulator/simulate.py seed`: 30 pre-flight + 120 mission days for 3 crew from `crew.yaml` (AR(1) noise + scenario effects), posted in batches with `X-Backfill: true`.
- [x] Calibrate the simulator with the published values in LLD §20.4: sleep, bone-loss drift, Mars-surface radiation ≈ 0.64 mSv/day with a ≈ 30 % neutron share. Note each source in `crew.yaml` comments.
- [x] Save real-data fixtures once (using your NASA key): `simulator/fixtures/donki-sep-2024-05.json` (May 2024 storm) and `horizons-mars-2026-07-to-11.json`. The simulator uses the SEP onset times for the `spe_radiation` scenario instead of a made-up day.

**Done when:** `python simulator/simulate.py seed` loads ~150 days × 3 crew, and Swagger UI (`/docs`) shows AST-001's resting-HR series rising from day 114. **Done 2026-11-14:** 6,649 readings (6,648 accepted, 1 questionable sensor glitch); a re-run stores nothing new; AST-001 resting HR goes 66 → 92 bpm from day 114 to 120. 74 backend tests pass.

---

### Step 3 — Baselines, rule engine, alerts, auth (Days 5–6) → **M1** ✅

**Goal:** the health brain works and is proven by tests.

**Tasks**
- [x] `astra/core/baselines.py` (robust median/MAD, floors, exclusions, pre-flight fallback) + tests T-B-01..04.
- [x] `astra/core/rules/engine.py` — `evaluate(rules, ctx)` pure function + an in-memory `EvaluationContext` for tests; tests T-R-01..05 (incl. T-R-03, the "same 85 bpm, different astronaut" case). T-R-06 (sensor glitch) is a scenario test.
- [x] `astra/core/alerts.py` (state machine, merge order) + `astra/services/alerts.py` (dedupe, escalation, auto-resolve, audit, outbox) + tests T-A-01..03.
- [x] Recommendation tasks created with each alert (in `astra/services/alerts.py`) and closed when the alert is resolved.
- [x] `astra/services/assessment.py` + ingestion: save → evaluate rules on the updated history (once per day for backfill) → alerts → tasks → baselines stored → audit → outbox; the router publishes WebSocket events.
- [x] Routers: `GET /api/astronauts/{id}/dashboard`, `GET /api/astronauts/{id}/alerts`, `GET /api/alerts/{id}`, plus `acknowledge` (astronaut) and `review` / `resolve` / `dismiss` (flight surgeon).
- [x] Auth: `POST /api/auth/login` + `GET /api/me` (PyJWT + bcrypt), `astra/security/deps.py` (`current_user`, `require_role`, `viewable_astronaut`), WebSocket requires `?token=`; test T-SEC-01.
- [x] **Scenario tests** (`tests/scenarios/`): the full ARES-1 mission and a healthy crew run through the real intake + assessment (T-R-04, T-R-06, T-SC-01).
- [x] Simulator CLI signs in (admin to post, flight surgeon to close past episodes before day 113).

**Done when:** scenario tests are green; Swagger shows AST-001 with a YELLOW `BEH-FATIGUE-COMPOSITE` alert and full evidence, and AST-002 GREEN. **Done 2026-11-14:**
- **Tests:** 119 backend tests pass in about 15 s; ruff and strict mypy are clean.
- **Live:** AST-001 is YELLOW with sleep deficit (from day 111), heart rate (day 116) and the fatigue pattern (day 117; reason: *4.4 h sleep vs 6.1 h normal, 92 bpm vs 64, fatigue 9/10*). AST-002 and AST-003 are GREEN.
- **Storm:** the real May 2024 storm raised an Urgent alert for all crew on days 87–91.
- **Healthy crew:** 1, 1 and 2 Attention alerts per astronaut (within the budget of 2).
- **Finding:** resting-HR σ_min raised 2 → 3 bpm to stop false alarms (LLD §5.4).

**Tag `m1-health-brain`.**

### Step 4 — Web: login, Overview, check-in, alerts, live updates (Days 7–10) → **M2** ✅

**Tasks**
- [x] Typed API client: `python -m astra.export_openapi ../../apps/web/openapi.json` then `npm run gen:api` (openapi-typescript via `npx`, because the project is on TypeScript 7 and the generator still declares TS 5) + `openapi-fetch` with an auth middleware.
- [x] Login page (demo-account shortcuts), Zustand auth store (persisted, falls back to memory), role guards: `/astronaut/*` for astronauts, `/staff/*` for flight surgeon / mission control / admin.
- [x] App chrome: mission code, mission day and Sol, SIMULATED badge, node + live-socket pill, sign out.
- [x] **Overview**: status header (GREEN / YELLOW / RED with icon + text), urgent banner, `VitalCard`s with "vs your normal" chips, active alerts, today's tasks (tick to complete).
- [x] **Check-in wizard** (sleep → how you feel → optional vitals → review; big sliders; 60 s timer) → `POST /api/checkins` (new backend router; scores + vitals become readings and are assessed at once) → result screen with new findings.
- [x] **Alerts Center**: Active / History tabs, expandable cards with the evidence table, emergency procedure, recommended actions checklist, Acknowledge; `?id=` deep links.
- [x] `src/lib/realtime.ts`: WebSocket `/ws?token=…`, exponential back-off reconnect, 25 s ping; events refresh the TanStack Query caches and raise toasts.
- [x] Backend: `POST /api/checkins`, `POST /api/tasks/{id}/complete`, `GET /api/catalog/indicators`, mission info in `/api/me`; `astra.seed --mission-day-today N`; the simulator loads history up to yesterday and closes all past episodes so today's check-in raises alerts live.
- [x] Minimal staff crew page (status per astronaut, read-only overview for the flight surgeon) so non-astronaut roles don't hit a dead end; the full surgeon dashboard is Step 8.

**Done when:** as `ast1` you finish a check-in in < 60 s and watch the YELLOW alert appear without refreshing. **Done 2026-11-14 (browser):**
- **Check-in:** completed in 38 s (sleep 4.5 h, mood 3, stress 8, fatigue 8, resting HR 91). It raised three new findings live: the fatigue pattern, resting heart rate +9.0σ, and sleep deficit.
- **Live update:** a second, never-reloaded Overview tab switched from *All clear* to *Attention · 3 alert(s)* through the WebSocket.
- **Alert detail:** shows the full evidence table.
- **Checks:** 125 backend tests pass; `tsc`, `vite build` and `oxlint` are clean.
- **Not covered in the browser:** the Acknowledge click wasn't exercised there (it is covered by API tests), and there are no frontend unit tests yet (Step 11).

**Tag `m2-walking-skeleton`.** From here on you always have a demo.

**Demo on any date:** use a fresh database, then:
```
python -m astra.seed --mission-day-today 121
simulator/simulate.py seed
```
Today is mission day 121; the history covers days −29…120.

### Step 5 — Analytics, wellness index, full rule set (Days 11–12) ✅

**Tasks**
- [x] **Health Analytics** page: *Compare vs your normal* (two indicators as σ from their own normal on one axis, default sleep vs resting HR) and *Single indicator* (`BaselineChart`: personal band, pre-flight line, alert periods, hollow flagged readings); 7 days / 30 days / mission; table view; wellness trend. Backend `GET /api/astronauts/{id}/analytics` and `/wellness`.
- [x] `astra/core/wellness.py` (LLD §9) + tests; daily `WellnessScore` stored at every assessment; ring + domain bars on Overview.
- [x] Routine tasks (`astra/services/routine.py`): check-in reminder, hydration, exercise when behind target; asyncio scheduler in `lifespan` (Habitat, every 15 min). *Assessments due* waits for assessment records.
- [x] 10 more rules: `CV-BP-HIGH`, `CV-BP-CRITICAL`, `RS-SPO2-LOW`, `RS-SPO2-CRITICAL`, `MET-GLUCOSE-LOW`, `MET-GLUCOSE-OUT`, `MSK-EXERCISE-ADHERENCE`, `MSK-STRENGTH-DECLINE`, `RAD-CUMULATIVE`, `IMM-STRESS-FEVER` (16 total, + 3 emergency procedures, + 6 recommendations), each with a positive and a negative test. `ENV-*` → Step 10, `SANS-VISION-SYMPTOM` → Step 7 (both need inputs that don't exist yet).

**Done when:** one chart shows sleep falling below its band while resting HR rises above its band. **Done 2026-11-14:**
- **The data:** from day 116 (9 Nov), AST-001's sleep is 4.0–5.2 h against a band of 5.2–7.3 h (−2.9σ to −4.8σ), while resting HR is 75–92 bpm against 58–70 (+3.7σ to +9.3σ).
- **The page:** in the browser, all 4 Analytics charts render. The compare chart has both series, the ±2σ band and the end labels; the single charts have alert markers and pre-flight lines; the wellness chart has both cap lines.
- **Checks:** 158 backend tests pass; ruff, mypy, `tsc`, `vite build` and `oxlint` are clean.
- **Healthy-crew false alarms:** still 1 / 1 / 2.
- **Not covered:** a visual screenshot of the charts (the browser window was minimized; the structure was checked through the DOM).

### Step 6 — ML insights (Days 13–15) → **M3** ✅

**Tasks**
- [x] `astra/ml/features.py` (daily vectors of robust z-scores; recovery strain), `isolation.py` (per-astronaut Isolation Forest, retrained weekly, versioned by a hash of its training days, joblib in `models/`), `trend.py` (Mann–Kendall + Theil–Sen on recovery strain).
- [x] `Insight` table; ML runs **inside the assessment**, before the rules, guarded by try/except and a 10 s budget (LLD §10.4 explains why this replaced `BackgroundTasks`).
- [x] Rule `ML-ANOMALY-CORROBORATED` (Attention only): anomaly ≥ 0.6 **and** rising recovery strain **and** a reading ≥ 2σ out. `op: insight` leaves name `ml_anomaly` / `ml_trend`; the loader refuses them in Urgent rules.
- [x] UI: "AI insights · last 7 days" on Overview; "What the AI noticed" in the alert detail; ML evidence rows named "AI anomaly score" / "Recovery strain trend". API `GET /api/astronauts/{id}/insights`, `insights` in the alert detail.
- [x] Tests: T-ML-01 (day 116 scores above the training 95th percentile), T-ML-02 (ML raises → API still 201, alerts still raised), ML unit tests, rule cases, scenario tests.

**Done when:** the fatigue scenario shows a trend insight about a day before the rule alert. **Done 2026-11-14:**
- **Trend insight on day 115** (AST-001: "Sleep, heart rate and how you feel drifted away from your normal together over 10 days…", p = 0.03). The resting-HR alert follows on day 116 and the fatigue composite on day 117.
- **Healthy crew:** 0 trend insights, 0 ML alerts; false alarms still 1 / 1 / 2.
- **Checks:** 178 backend tests pass; ruff, mypy, `tsc`, `vite build` and `oxlint` are clean. A full mission replay takes about 30 s with the ML.
- **In the browser:** the Overview shows the insights with their contributor chips; the ML alert's detail shows the ML evidence rows and five related insights.
- **Tuning findings** (recorded in LLD §10):
  - Per-indicator trends fired 5–40 false episodes per healthy astronaut, so the trend runs on a combined recovery-strain score instead.
  - Isolation Forest scores level off around 0.6–0.7 even for 9σ days, so the anomaly score only corroborates.
- **Not covered:** a visual screenshot (the browser pane could not draw; the page was checked through its DOM text).

**Tag `m3-insightful`.**

---

### Step 7 — AI Health Assistant with RAG and safety router (Days 16–18) → **M4** ✅

**Tasks**
- [x] Knowledge base: 29 notes (91 sections) in our own words from the 5 hackathon-provided pages: one per hazard, the relevant NASA risks, countermeasures, the CSA neutron-radiation article and how the app judges readings. Every note cites only those URLs (checked by a test).
- [x] `astra/assistant/knowledge.py`: heading-based chunks + BM25 (`rank_bm25`), built at startup. It weights note titles double, ignores words every question shares ("Mars", "astronaut"…) and maps everyday words to the notes' terms ("lonely" → isolation).
- [x] `protocols/redflags.yaml` + `redflag.py` (T-AI-01). It handles negations ("no chest pain") and hypothetical questions (protocol shown, no alert), unless the person is clearly reporting it now. Two new procedures: `EMG-NEURO-SYMPTOMS`, `EMG-SEVERE-BLEEDING` (10 in total).
- [x] Providers: `template.py` (works with no key) and `claude.py`.
  - `claude.py` uses the official `anthropic` SDK with model `ASTRA_LLM_MODEL` (default `claude-opus-5-5`), structured JSON output, effort `low` and the server-side refusal fallback.
  - A refusal, a cut-off answer or an API error falls back to the template.
  - `ollama.py` is **not built** (stretch).
- [x] `guard.py`: no doses, medication instructions or diagnoses; only retrieved citations; escalation line; a fixed "ask the CMO" line for any medication question (T-AI-02..04).
- [x] API:
  - `POST /api/assistant/chat` builds findings from the dashboard and recent insights, answers, stores `ChatMessage`s and audits without the question text.
  - A red-flag *report* from an astronaut creates a `Symptom` and an Urgent `SYM-*` alert, pushed live.
  - Also `GET /api/assistant/history` and `/status`.
- [x] Chat UI: suggested questions, citation chips linking to the source page, provider badge ("Onboard · offline" / "Earth relay · Claude" / "Emergency · no AI"), `EmergencyProtocolCard`. The 10 emergency procedures are bundled into the web app at build time, so they open even when the backend is down.

**Done when:** the same question answers via Claude with a key set and via the template without one, and "I have chest pain" instantly shows the emergency card and creates an Urgent alert. **Done 2026-11-15:**
- **Chest pain (in the browser):**
  - "I have chest pain" shows the chest-pain procedure at once, with no AI call.
  - The Urgent alert `SYM-CHEST-PAIN` appears in the Alerts Center with its evidence, procedure and "contact the CMO" task.
  - The Overview turns RED.
- **Template (live and in the browser):** "Why is my resting heart rate increasing?" answers with "Your resting heart rate is 92 bpm; your personal normal is 64 bpm, so this is 9.3σ above your normal", the AI insight and the fatigue-recovery note, with citations.
- **Claude:** the same question goes through the Claude provider in an API test, using a mocked SDK client; it gets the same citations and history, and Claude is chosen whenever a key is configured. **Not run against the real Claude API:** no `ANTHROPIC_API_KEY` is set on this machine. Add one to `services/backend/.env` and restart to try it.
- **Checks:** 222 backend tests pass (44 assistant tests); ruff, mypy, `tsc`, `vite build` and `oxlint` are clean.
- **Not covered:** a visual screenshot (the browser pane could not draw; the pages were checked through their DOM text). Symptom intake outside the chat (a symptom form, and `SANS-VISION-SYMPTOM`) is not built yet.

**Tag `m4-assistant`.**

---

### Step 8 — Medical reports & Flight Surgeon dashboard (Days 19–20) ✅

**Tasks**
- [x] `astra/services/reports.py`:
  - Daily, weekly, alert-triggered and on-demand reports. Each has a `SummaryJson` (values vs the personal normal, alerts, AI insights, wellness, adherence, radiation, red-flag symptoms, instructions) and a narrative.
  - The narrative comes from Claude when a key is set (facts from the summary only, guarded like chat), else from a deterministic template.
  - Automatic reports come from the 15-minute routine loop and are idempotent: yesterday's daily, the last complete Mon–Sun week, and one per active Urgent or escalated alert.
  - Every report is queued in the sync outbox; alert reports for Urgent alerts get priority 1.
- [x] Reports page (astronaut 07, and the surgeon's Reports tab): list with a Queued/Sent/Delivered chip, the report view (summary, readings-vs-normal table, alerts, wellness, adherence, radiation, AI insights), "New (last 7 days)", and **Print / PDF** with a print stylesheet that prints only the report. Statuses stay *Queued* until the deep-space link exists (Step 9).
- [x] Surgeon routes:
  - **Crew grid** (`GET /api/crew/summary`): status, live wellness index, alert counts, top alert, alerts awaiting review, unacknowledged instructions, latest report and "data as of". Mission control sees status, counts and data time only.
  - **Astronaut detail** with tabs: Summary, Alerts review, Trends, Reports, Instructions.
  - **Alert review**: Start review / Resolve / Dismiss with a note, plus "send an instruction about this alert".
  - **Send instruction** (`POST /api/instructions`), pushed live to the astronaut (`InstructionReceived`). It appears as a banner and toast on their Overview; they acknowledge it, and the surgeon gets a live toast.
- [x] Audit entries for surgeon reads: `SurgeonRead` for any astronaut data read (once per 10 minutes per surgeon, astronaut and kind of data, so the grid's refreshes don't flood the log). `ReportRead`, `ReportGenerated`, `InstructionSent` and `InstructionAcknowledged` are also audited. (The surgeon UI still talks to the Habitat node; Step 9 moves it.)

**Done when:** the surgeon reviews the fatigue alert, reads the report, sends an instruction, and the astronaut sees it live. **Done 2026-11-15** (live demo data, mission day 121):
1. The astronaut's check-in (sleep 4.5 h, resting HR 91, fatigue 8) raised the fatigue-pattern, resting-HR, sleep-deficit and ML-corroborated alerts. The crew grid turned AST-001 to Attention, with "3 alert(s) awaiting your review".
2. The surgeon started review of the fatigue alert (In review).
3. The surgeon generated and read a report: "resting heart rate 83 bpm vs normal 64 (+5.3σ, latest 91); sleep duration 4.5 h vs normal 6.2 (−3.1σ)…; AI insights: rising recovery strain on 6 day(s) from 2026-11-09".
4. The surgeon sent an instruction about the alert.
5. The astronaut's Overview, open in the browser and never reloaded, showed "Message from Flight Surgeon (demo)" as a banner and a toast. Acknowledging it updated the surgeon's Instructions tab to "acknowledged".

- **Checks:** 228 backend tests pass; ruff, mypy, `tsc`, `vite build` and `oxlint` are clean.
- **Not covered:**
  - Visual screenshots (the browser pane could not draw; the pages were checked through their DOM text).
  - The Claude-written narrative ran only with a mocked SDK client (no key on this machine).
  - The printed PDF layout was not inspected.

---

### Step 9 — Offline-first: PWA, Ground node, deep-space link (Days 21–23) → **M5** ✅

**Tasks**
- [x] `vite-plugin-pwa` 2.0: app shell precached (12 files, ≈ 1 MB, including the bundled emergency procedures); manifest; installable. The service worker exists in production builds only (`npm run build && npm run preview`).
- [x] Offline reads and writes (LLD §12.6):
  - `persistQueryClient` keeps the last screens on the device for 24 h; they are cleared on sign-out or user change.
  - A Dexie outbox holds check-ins (sent later with the same client id, so never stored twice), tied to the user who made them.
  - An "Offline — showing data saved on this device at 07:42" banner, with a count of items waiting to be sent.
  - Test T-UI-02 is **not automated yet** (no frontend test runner until Step 11).
- [x] The backend runs a second time as the **Ground** node (`ASTRA_NODE_ROLE=Ground`, port 8001, `ground.db`).
  - Seeded ids are stable (UUIDv5 from codes and usernames), so both nodes agree and a token from one works on the other.
  - The Ground node refuses readings and check-ins (409).
- [x] `astra/sync/` (envelope, link, merge, engine):
  - Outbox on every syncable change: measurements, alerts, reports, instructions, ML insights, space weather.
  - A sync loop every 2 s on both nodes.
  - Receiver `POST /node/sync/envelopes`, HMAC-signed with `ASTRA_SYNC_KEY`; `SyncInbox` by envelope id makes a re-sent envelope a no-op.
  - Delayed ACKs (`/node/sync/acks`), and a retry after 2 × delay + 30 s.
- [x] Link simulation (`astra/sync/link.py`, `LinkState` on the Habitat): Up/Down and delay × compression (2 s per light-minute), controlled by `GET/PUT /api/admin/link`. The Habitat stamps the arrival time on what it sends and refuses (503) Ground traffic while the link is Down.
  - **Simplified:** no blackout schedule or drop/duplicate rates. Duplicates and lost ACKs are covered by tests instead.
- [x] Alert merge by state order (Open < Acknowledged < InReview < Resolved/Dismissed; trigger fields follow the newest trigger).
  - Instructions flow Ground → Habitat; the Habitat reports the delivery time back; acknowledgements flow back too.
  - Reports become Sent → Delivered.
  - Tests T-S-01..03 and T-A-03 (`tests/sync/test_sync.py`: two real apps in-process, simulated time).
- [x] `astra/integrations/`:
  - DONKI (`nasa_donki.py`) and Horizons (`horizons.py`) were already built.
  - New `SpaceWeatherEvent` table and `services/space_weather.py`: the Ground node fetches DONKI SEP events every hour (needs `ASTRA_NASA_API_KEY`), stores new ones and queues them for the Habitat. Live check: the key works; 0 SEP events in the last 30 days.
  - **Not built:** `noaa_swpc.py` (proton flux) and a habitat-side display of the notices (Step 10, environment & radiation).
- [x] Link delay defaults to the real JPL Horizons Earth–Mars light time for today, from the cached table: 11.0 min on 2026-11-14, i.e. 22 s in demo time.
- [x] **Demo Control Panel** (`/staff/sim`, Admin), with:
  - link UP/DOWN;
  - the real Horizons delay plus a manual override slider and "use today's real light time";
  - both queues (waiting / in flight / delivered, last received / last ACK);
  - "inject fatigue episode" and "replay May 2024 solar storm peak" (through the normal intake, so they raise alerts and reports and sync).
  - **Not built:** a mission-day control and a reset button (the panel shows the rebuild commands).
- [x] Surgeon and mission-control routes use the Ground node:
  - Vite proxies `/ground-api` and `/ground-ws` to :8001; the API client rewrites `/api` for those roles.
  - Earth-copy banner: light-time delay, last received, "link DOWN — newer onboard data is waiting".
  - Link pill in the header: "Earth link UP · 11.0 light-min · N queued".
- [x] New live alerts (check-in, wearable readings, scenarios) produce one AlertTriggered report at once, so the report travels with the alerts.

**Done when:** with the link DOWN a check-in raises an alert onboard and the surgeon sees nothing; flip the link UP → after the simulated delay the alert and report appear on Ground exactly once; the surgeon's instruction arrives onboard after the return delay. **Done 2026-11-15** (two live nodes, browser + API):
1. **Link down:** the check-in raised 4 alerts onboard (fatigue pattern, resting HR, sleep deficit, ML-corroborated). The surgeon's crew grid on Earth still showed AST-001 "All clear", under "Link DOWN — newer onboard data is waiting".
2. **Link up:** the 4 alerts and the AlertTriggered report (Delivered) appeared on Ground **24.4 s** later (22 s light time + ≤ 2 s loop). The surgeon's open grid switched to Attention live.
3. **Parity:** both nodes hold 14 alerts and 6,655 readings, with no duplicates; all 7 reports are Delivered on both. The ≈ 6,650 history readings crossed in ≈ 30 s.
4. **Return path:** the surgeon's In Review reached the Habitat, and the instruction arrived onboard ≈ 23 s after sending. A second instruction appeared on the astronaut's open Overview, without a reload, 24 s after sending; until then Earth showed it as not yet delivered.
5. **Checks:** 234 backend tests pass (6 new sync tests); ruff, mypy, `tsc`, `vite build` and `oxlint` are clean.

**Not covered:**
- Offline behaviour was not exercised in the browser (stopping the Habitat server mid-check-in), and there is no automated T-UI-02.
- The service worker was not tested in a production preview.
- No visual screenshots: pages were checked through their DOM text.
- `npm install` reported audit warnings in the PWA build tooling; left as is.

**Tag `m5-earth-link`.**

---

### Step 10 — Body Explorer, Wellness Center, environment & radiation (Days 24–26) → **M6** ✅

**Tasks**
- [x] `GET /api/astronauts/{id}/body-systems` (`astra/services/body.py`, LLD §15.3), with 9 regions: brain, eyes (SANS), heart, lungs, digestive, immune, muscles, bones, whole body (radiation). Each region has:
  - its readings vs the personal normal, with a 14-day sparkline;
  - active alerts whose rules read its indicators (red-flag symptom alerts mapped by type);
  - the pending tasks of those alerts;
  - "what changes in space" and "what you can do" from the knowledge base, with the source;
  - a status: RED Urgent / YELLOW Attention or ≥ 2σ / GREEN / GREY no data.
- [x] **BodyMap2D** (SVG, keyboard-accessible regions) → `RegionPanel` (readings, sparkline with the ±2σ normal band, alerts linking to the Alerts Center, next steps, knowledge).
- [x] **BodyModel3D** (React Three Fiber 9.8 + drei 10.7, three 0.187): first a stylised body from primitives; replaced in Step 11d by a human figure sculpted in code (no external model licence to track).
  - Meshes per region, coloured by status, with hover and click; drag to rotate.
  - A 2D/3D toggle; lazy-loaded (≈ 0.9 MB chunk, only in the 3D view).
- [x] **Wellness Center** (`GET /api/astronauts/{id}/wellness-center`, `POST /api/wellness/activity`):
  - box-breathing exercise (logged when finished);
  - hydration tracker (+250/+500 mL; reaching the target ticks off today's hydration task);
  - 7-day fluid and sleep bars;
  - exercise adherence ring vs the mission target, and strength;
  - sleep routine tips;
  - five wellness missions with progress and a check-in streak.
- [x] **Environment & radiation panel** (Body Explorer, astronaut and surgeon):
  - **Cabin air:** an `EnvironmentReading` store (habitat-wide; the simulator posts temperature, humidity and CO₂ every 6 h), `POST /api/environment/readings` and `GET /environment/current`.
  - **Radiation** (`GET /api/astronauts/{id}/radiation`):
    - daily dose per channel (charged vs neutron);
    - mission total vs the 600 mSv limit and the neutron share;
    - a solar-particle-event banner with the shelter protocol;
    - real inputs labelled: "Real NASA DONKI solar particle events, 09–13 May 2024 — replayed on mission day 87" and "Earth–Mars light time today: 11.0 min (JPL Horizons)".
  - **Rules:** `ENV-CO2-HIGH` and `ENV-HEAT-HYDRATION` are now built (19 rules), plus `REC-CABIN-CHECK` (22 recommendations). Cabin readings sync to Earth.
- [x] Ground / mission control **"Space weather now"** card (`GET /api/space-weather/now`, `astra/integrations/noaa_swpc.py`): NOAA GOES ≥ 10 MeV proton flux against the 10 pfu S1 threshold, on a log scale. It is live on the Ground node (refreshed every 15 min) and falls back to a cached sample (labelled) on the Habitat or offline. It also shows recent DONKI SEP events and the light time.
- [ ] Mission timeline (stretch) — **not built**.

**Done when:** clicking the heart shows resting HR vs baseline, the fatigue alert and the reduced-gravity explanation. **Done 2026-11-15** (live demo data, browser):
- **The heart, after a fatigue check-in:**
  - "Resting heart rate 91 bpm · your normal 64 bpm · +9.0σ";
  - the alerts "Fatigue and recovery pattern needs review", "Resting heart rate above your personal normal" and "Unusual pattern confirmed by readings";
  - six next steps;
  - "What changes in space · Heart and blood vessels in reduced gravity — Without normal gravity, body fluids shift toward the head…".
- **Wellness Center:** "+ 500 mL" updated today's total live (0 → 500).
- **Space weather:** the Ground node showed live NOAA flux (0.225 pfu, below S1); the Habitat showed the cached sample, labelled.
- **Cabin history:** 1,440 readings added no false alerts (the same 5 / 2 / 3 history alerts as before).
- **Checks:** 242 backend tests pass (new: body-systems "done when", the CO₂ alert for the crew, radiation channels, space weather, wellness, and the environment rule cases); ruff, mypy, `tsc`, `vite build` and `oxlint` are clean.

**Not covered:**
- The 3D view was mounted but not seen: the browser pane could not draw, so there are no screenshots and pages were checked through their DOM text.
- Live space-weather notices are not shown onboard yet (only the replayed May 2024 storm and stored DONKI events).
- `npm install` reported audit warnings, left as is.

**Tag `m6-wow`.**

---

### Step 11 — Hardening & evaluation (Days 27–28) ✅

- [x] Run the full test catalogue (LLD §19); fix failures. `ruff check`, `ruff format`, `mypy` (strict) clean. New: T-S-03 (tampered envelope), T-EXT-02 (no NASA key), T-EXT-04 (space-weather event reaches the Habitat), restart mid-sync.
- [x] Record prototype metrics: `python -m astra.evaluate` replays the ARES-1 mission and a healthy crew through the real pipeline and writes [`docs/evaluation/EVALUATION.md`](evaluation/EVALUATION.md) + `metrics.json`.
- [x] Edge cases: missing days (sparse baseline, astronaut with no data = GREEN), sensor glitch (Questionable, no alert), unit mix-ups (µSv → mSv, °F → °C; a fraction typed as % and HR in mmHg are rejected), long chats (2,000-character limit, at most 6 history turns sent to Claude), backend restart mid-sync (nothing lost, no duplicates).
- [x] Accessibility pass: axe-core (WCAG 2.1 A/AA) on the login page, all 8 astronaut pages and the crew view: no serious or critical violations. Fixed: Overview had no `<h1>`; the Analytics indicator menus had no name; "button inside a link" replaced by `LinkButton`. Status already uses colour + icon + text.
- [x] Security pass: `.env` and `*.db` git-ignored and `.env.example` empty (tested); every `/api` route needs sign-in (T-SEC-01); CORS limited to the web origin (tested); login rate-limited (5 failures in 5 min → HTTP 429 + `Retry-After` for 5 min); security headers (`nosniff`, `DENY`, `no-referrer`, `Cache-Control: no-store` on health data); warning at start-up if the JWT secret or sync key is still the dev default.
- [x] Playwright e2e for the demo path (`npm run e2e`; own backend on :8100 with a fresh mission database, own Vite on :5174): T-UI-01 demo path, T-UI-02 offline check-in, chest pain → emergency card + Urgent alert, 10 axe scans. CI job `e2e`.
- [x] Performance: dashboard < 1 s with 150 days × 3 crew — measured **47 ms** median (crew summary 270 ms, mission analytics 52 ms); no extra indexes needed.

**Done when:** the test catalogue, the metrics and the e2e demo path all pass. **Done 2026-11-15:**
- **Metrics** (simulated, seed 42): both scenario events detected (fatigue: rule alerts on day 116, trend insight day 115, onset day 114; solar storm: Urgent for 3/3 crew on day 87); median time to detection 1.0 day; the sensor glitch was marked Questionable and raised nothing. Healthy crew over 150 days: 4 Attention alerts in total (1 / 1 / 2), 0 Urgent, 0 trend insights.
- **Checks:** 257 backend tests and 13 browser tests pass; ruff, ruff format, mypy, `tsc`, `oxlint` and `vite build` are clean.

**Not covered:**
- The healthy crew still gets 4 Attention alerts and 20 single-day anomaly insights in 150 days: an acceptable but not zero false-alarm budget for a prototype; thresholds were not tuned to the simulator.
- Metrics come from the simulator, not real crew data; they show the pipeline works, not clinical accuracy.
- Screen-reader testing by hand (NVDA / VoiceOver) was not done; only automated checks.
- The login limiter is in memory per server process.

**Tag `m7-hardened`** (optional).

---

### Step 11b — Human-centred UI redesign ✅

**Goal:** an astronaut who is tired, busy and far from Earth understands their health in seconds. Information first; plain language; nothing decorative; missing data never shown as normal. Details: LLD §15.4–15.5, HLD §7.

- [x] Design system: light clinical tokens (contrast-checked), white header with mission context and link status, task-based side menu (Home, My Health, Daily Check-in, My Guidance, Wellness, Health History, AI Assistant) with badges, phone drawer, skip link, Emergency procedures always in the menu.
- [x] Home: status in words (never an unexplained score), "Something to pay attention to" (what changed · measurement vs normal · what it means · why it matters · what to do · when to get medical help), key measurement cards (normal range, previous reading, source, time, history link), today's tasks with progress.
- [x] Daily Check-in: 8 guided steps with how-to, units, validation, re-measure, explicit "not measured", wearable value, symptoms (red flags → Urgent alert + procedure), review table.
- [x] My Health: body-system list + diagram with the 7-part explanation; Trends with quick views, "What changed" sentences, daily/weekly tables.
- [x] My Guidance and Health alerts; Wellness in four areas; AI Assistant limits; Health History timeline; flight-surgeon crew overview with communication status, follow-ups and table.
- [x] Backend (additive): vitals' previous value, source and quality; check-in symptoms; `GET /catalog/symptoms`, `/timeline`, `/guidance`; a re-sent check-in is a no-op.

**Done when:** every visible control works, every page passes axe, and the demo path still works. **Done 2026-11-15:**
- **Checks:** 265 backend tests (8 new) and 23 browser tests pass, including 16 axe scans with no serious or critical violations, the guided check-in, offline sync, both emergency paths, navigation and the phone drawer. ruff, mypy, `tsc`, `oxlint` and `vite build` are clean.
- **Found and fixed by the checks:** amber on its own tint was 4.39:1 (token darkened to `#9A4507`); slider labels read as "Mood 7 / 10good 1 · very low …" (now just "Mood" with the scale as a description); a resent check-in id hit a primary-key error (now a no-op).

**Not covered:**
- Screen-reader testing by hand and testing on a real tablet were not done; only automated checks and browser emulation.
- Food intake logging has no backend; the page says so instead of showing fake data.
- Explanations are educational text from the knowledge base, not mission-approved medical content; recommendations remain marked "Illustrative".

---

### Step 11c — Challenge-brief gaps ✅

**Goal:** close what a review against the challenge brief found missing: blood sugar could not be entered by hand, gamification was thin, there was one environment and no camera input. Details: LLD §8, §8.1, §13.2, §15.5; TDD §1.6.

- [x] Daily check-in: new step **Blood sugar and body mass** (how-to, mg/dL / kg, your normal, re-measure; < 54, < 70 and ≥ 250 mg/dL show safety advice with the procedure link; body mass is weekly, so "Not measured today" is normal). The backend already accepted both.
- [x] **My progress**: `GET /astronauts/{id}/progress` (points, 10 levels, 4 streaks, weekly goals, 8 badges), computed from existing data. Points reward actions, never readings. Home card, Wellness "Progress and badges", streak and points on the check-in result.
- [x] **Mission environments**: 4 profiles (ISS, Mars transit, Moon rover, Mars base) with environment, gravity, delay, evacuation, targets and health focus; `GET /mission`, Admin `PUT /admin/mission/profile` (link delay follows; synced to Ground as a `Mission` item); Home "Your environment" card; header chip; Demo control picker.
- [x] **Photos**: `HealthPhoto` table; `POST /photos` (JPEG/PNG/WebP, ≤ 2 MB, magic bytes checked, idempotent), list and image endpoints; synced to Ground (`PhotoAdded` toast for the surgeon); check-in photo step with live camera or file/tablet camera, shrunk to ≤ 1280 px; Health History shows the image.

**Done when:** each gap works end to end and the existing checks still pass. **Done 2026-11-15:**
- **Checks:** 273 backend tests (8 new: T-PS-01..03) and 25 browser tests (2 new: T-UI-06) pass, including 16 axe scans of the pages with the new cards. ruff, mypy, `tsc`, `oxlint` and `vite build` are clean.
- **Changed by the review:** with 150 days of history the demo astronaut started at the top level, so the levels were spread to 10 (the demo now lands at level 7 of 10).
- `ASTRA_E2E_WEB_PORT` lets the browser tests run when port 5174 is taken.

**Not covered:**
- Photos are never analysed (by design); there is no image annotation or comparison over time.
- Live camera tested only through the file input in Playwright; `getUserMedia` was not exercised by an automated test.
- Mission environment values are illustrative; switching keeps the same simulated crew history (made for Mars).
- The running Ground node must be restarted to pick up the new sync items (it runs without `--reload`).

---

### Step 11d — Realistic human body figure ✅

**Goal:** the body figure was built from circles and spheres and did not look human. Replace it with a realistic, interactive figure, with no downloaded model (no licence, no large asset). Details: LLD §15.5 (Body figure).

- [x] **One anatomy model in code** (`features/body/anatomy.ts`): the body and organ systems as signed distance functions: a 1.76 m adult (head with face, ears and nose; neck, shoulders, chest, abdomen, hips; arms with hands and thumbs; legs with knees, calves and feet) smoothly blended into one skin. Inside: brain (lobes, cerebellum, stem), eyes, lungs (domed base, heart notch), heart with aorta, liver, stomach, intestines, lymph nodes, spleen and thymus, limb muscles, and a skeleton (spine, collarbones, pelvis, arm and leg bones, kneecaps).
- [x] **3D view**: meshed in a Web Worker with surface nets (`surfaceNets.ts`, `bodyMesh.worker.ts`, ≈ 1–2 s once per visit); see-through skin (rim-lit shader); the chosen system and any system not within normal are solid and status-coloured (the chosen one pulses), the others are faint ghosts. Hover names the part and its status; click selects the front-most part; choosing a system moves the camera to it. Controls: Front / Side / Back, Turn (slow auto-rotate, off with reduced motion or on any drag), Skin (show or hide), soft floor shadow.
- [x] **Flat view**: generated from the same model (`scripts/gen-body-map.ts` → `bodyMapPaths.ts`, front projection traced with marching squares, 12 KB); skin shading, the same solid / faint rule, keyboard buttons for the 8 systems plus the skin (whole body, radiation).

**Done when:** both views look like a human body, every system can be chosen by mouse and keyboard, and the existing checks pass. **Done 2026-11-15:**
- **Checks:** new browser test T-UI-07 (flat clicks and keyboard, 3D build and controls); the full browser suite passes (26 tests); `tsc`, `oxlint` and `vite build` are clean. The worker is a 7 kB chunk; the 3D chunk is unchanged (≈ 0.94 MB, lazy).
- To change the anatomy, edit `anatomy.ts`, then run `node scripts/gen-body-map.ts` (Node 23.6+) to redraw the flat view.
- **Layout fix:** screen-reader-only text was positioned against the page instead of the scrolling content area, so the page grew taller than the window and scrolling left a blank band below the app. The content area and sidebar are now `relative`; the navigation test checks that every page is exactly the window height.

**Not covered:**
- Shapes are educational, not a medical atlas: no skin texture, face detail, fingers or individual ribs.
- Clicking inside the 3D canvas is tested by hand only (the automated test drives the buttons and the list).

---

### Step 12 — Demo, pitch, documentation (Days 29–30) → **M7**

- [x] `start-demo.ps1` (repo root): checks the setup and the ports (reuses a port that already runs the demo; otherwise says which program holds it), creates the databases on first run (mission day 121), opens one window each for Habitat (8000), Ground (8001, now with `--reload`) and web (5173), waits for all three, loads the mission data and opens the browser. `-Fresh` resets to mission day 121, `-Stop` closes what it started (`.demo-pids`), `-HabitatPort/-GroundPort/-WebPort` move the ports. Tested 2026-11-15 from an empty checkout on spare ports: ready in 74 s, 6,649 readings, Ground received the data, `-Stop` freed all ports; and with the servers already running (all reused).
- [ ] Rehearse the 5-minute script (§7) at least 5 times; record a backup video.
- [ ] Slides: problem (5 hazards, comms delay, from the organizer sources) → solution → live demo → architecture (HLD diagram) → safety design (rules decide, ML corroborates, LLM explains) → **NASA 17-risk coverage** (TDD §13) → metrics → **Earth benefits** (TDD §14) → roadmap.
- [x] README with screenshots, how to run, disclaimers, sources, licence credits. Regenerate doc PDFs (`tools/docs-pdf`).
  - Screenshots in `docs/screenshots/` (Home, check-in, 3D body, progress, flight surgeon, demo control) are taken by `apps/web/scripts/screenshots.ts` from a fresh demo (it waits until the link has delivered the mission data). To refresh: `.\start-demo.ps1 -Fresh`, then `cd apps/web; node scripts/screenshots.ts`.
  - Fixed on the way: a reached weekly goal read "6 of 5 days"; it now reads "6 days · goal met".
- [x] **Online deployment** (`deploy/`, guide in `deploy/README.md`): web app on **Vercel** (`apps/web/vercel.json`: `/api` and `/ground-api` forwarded to the server, SPA fallback, cache headers; `VITE_LIVE_ORIGIN` points live updates straight at the server because Vercel can't forward WebSockets); Habitat and Ground on one **Google Cloud** VM with Docker Compose (`backend.Dockerfile`: one image, role from environment; first start creates the database and loads the simulated mission once; `web.Dockerfile` + `Caddyfile`: the app and both backends behind automatic HTTPS, free `sslip.io` name). Secrets only in `deploy/.env` on the server. Checked: the production build with `VITE_LIVE_ORIGIN`, `vercel.json` and compose files parse; the containers were **not** built locally (no Docker on the development laptop) — the first build happens on the VM.
- [ ] **Tag `v1.0-demo`.**

---

### Step 13 — Camera exercise coach

**Goal:** resistance exercise is the main protection against bone and muscle loss, but in the app it was only a weekly count. Add a coach that plans today's session from the astronaut's condition, watches the exercise through the laptop camera, counts reps and sets, gives posture tips (on screen and spoken), times the rest between sets, and records the result like any other reading. Details: LLD §15.6 (Exercise coach).

Design rules:
- **The video never leaves the device.** Body tracking (MediaPipe Pose Landmarker, Apache-2.0, 33 body points) runs in the browser, offline: the engine and the model (`public/models/pose_landmarker_full.task`, 9.4 MB) are served by the app itself. Only the results are saved: sets, reps, form score, and the posture tips given.
- **Rules count and coach; the language model does not.** Rep counting and posture checks are geometry on joint angles (a state machine per exercise, testable without a camera). Thirty images a second is far too fast for a language model; the summary afterwards is plain text from the same results.
- **Plan from approved data.** `protocols/exercise-plans.json` holds the exercises, the base plan and the adjustments, keyed on active alert rules (fever: rest day; urgent alert: rest day; fatigue, poor sleep or a high resting heart rate: lighter; strength falling or sessions behind: one more set of squats and deadlifts). It is checked at start-up like the other protocols.
- **Same path as every reading.** A finished session is stored (`ExerciseSession`, synced to Ground) and updates `activity_min` and `exercise_sessions` through the normal intake, so rules, progress, badges, today's exercise task and the flight surgeon all see it.
- Coaching, not a medical device; ARED, CEVIS and T2 are not simulated. Movements a camera sees well are coached: squat, deadlift (hip hinge), heel raise.

- [x] Plan: `exercise-plans.json`, loader checks, pure `core/exercise.py`, `GET /api/astronauts/{id}/exercise-plan`.
- [x] Results: `POST /api/exercise/sessions` (idempotent client id), `ExerciseSession` table and sync, readings through intake, today's exercise task done.
- [x] Coach engine (`features/exercise/`): joint angles, per-exercise rep counter and posture checks, whole-body-visible check, form score.
- [x] Coach page (Wellness → Exercise coach): today's plan with reasons, camera with body-point overlay, rep and set counter, posture tip (spoken, can be muted), rest countdown, summary and save; camera errors explained.
- [x] Demo playback: a simulated person does the plan (with a few deliberate mistakes) for rehearsals, tests and a stage without space; clearly labelled.
- [x] Flight surgeon sees recent coached sessions.
- [x] Tests: backend (plan rules, results, sync), coach engine on generated movement, browser test with demo playback.

**Done when:** the plan follows the astronaut's condition with the reason shown, a workout counts reps and sets and gives posture tips, the result reaches the flight surgeon, and the existing checks pass. **Done 2026-11-15:**
- **Checks:** backend T-EX-01..05 (plan rules, summary, protocol check, API, sync); coach engine T-EX-06..09 (`npm run test:unit`, 8 tests: clean reps of each exercise, every deliberate mistake, front view, out of view, whole workout, early finish); browser T-UI-08 (demo workout at 20×, saved, tips) and T-UI-09 (Chrome's fake camera: engine and model load from the app, tracking runs); the coach page is in the accessibility scan. Full backend and browser suites pass; `tsc`, `oxlint`, `ruff`, `mypy` and `vite build` are clean.
- **By hand:** a full demo workout in the browser (99 reps, all 8 mistakes caught, form 97%), saved, and seen on Ground by the flight surgeon after the link delay.
- Package `@mediapipe/tasks-vision` pinned at 1.2.0 (released 2026-10-27); the model is committed (9.4 MB) so the demo needs no download. The engine is not precached by the PWA (≈ 24 MB); it is cached after the first use.
- Demo playback steps the simulated person in fixed 1/30 s slices, so a slow screen or `?speed=` never skips the bottom of a rep.

**Not covered:**
- **Counting on a real person through a real camera is not yet tested.** The thresholds come from typical joint angles and were checked on the simulated person only; they need tuning with someone exercising in front of a webcam (side-on, 2–3 m, good light).
- Posture checks from body points are limited: the camera cannot see a rounded back, the bar or the load. Bench press, CEVIS and T2 are not coached. One person in view only.

---

### Step 14 — Calm, simple screens for the crew ✅

**Goal:** after testing, the astronaut screens read as "a bunch of information": every page showed all its numbers, statistics words (σ, model scores) and explanations at once, and assistant answers needed medical knowledge. In a hazard, the crew needs to know *how they are* and *what to do* in seconds. Details: LLD §15.7 (Simple screens).

Design rules:
- **One answer first.** Every page opens with the answer to its question in one or two sentences (Home: "How am I today?", My Guidance: "What should I do?"), then at most a few cards. Everything else (numbers against the usual range, sources, how a rule decided) is folded under **More detail**.
- **Everyday words.** No σ, z-scores, "baseline" or model scores on astronaut screens; readings are "Normal", "A bit high", "Very low", "Measure again". Three levels everywhere: **OK** (green), **Take care** (amber), **Get help now** (red), always with an icon and a word.
- **Gamified, not noisy.** Home shows **Today's quests** (check-in +10, move 30 min +5, water +5, sleep 7 h +5) with streaks, bonus quests from guidance (+5), and the level bar; the check-in and guidance buttons say what they earn.
- **Two themes.** Calm light (default) and Mission dark (deep navy, for dim cabins), switched from the header and remembered on the device; until chosen, the app follows the device setting. One teal accent for actions; status colours only for status. Both themes pass the WCAG AA contrast scan.
- **The flight surgeon keeps the detail.** Staff pages (crew, astronaut summary, alerts review) still show every number and rule.

- [x] Theme tokens for light and dark (`index.css`), header switch (`ThemeToggle`, `lib/theme.ts`, applied before the first paint), charts, body map and sparklines on tokens.
- [x] Plain-language helpers (`lib/plain.ts`): a word per reading, the one-sentence summary of how you are. Shared blocks (`components/ui/Simple.tsx`): page header with its purpose, answer card, More detail.
- [x] Home (`features/overview/SimpleHome.tsx`): answer card with one action, Today's quests, Your body today (6 tiles, numbers folded), level and streak, the environment in one line.
- [x] AI assistant: answers are a **short answer** (1–2 sentences, ≤ 35 words), up to **3 steps** ("What helps"), a **get help** line when the app flagged it, and the explanation and sources under More detail. Claude prompt and JSON schema changed (`short_answer`, `detail`); the offline template answers the same way; stored as "short answer, blank line, detail", so old databases keep working. Six everyday starter questions.
- [x] My Health (one sentence per body part; readings with a word; What helps; Watch for; the textbook explanation folded; cabin air and radiation folded), My Guidance (one summary, short action cards with Why / When / Mark as done +5, How and why folded), Health alerts (what happened, what to do, medical help; numbers and machine-learning notes folded for astronauts), Wellness (readings as a value and a word, tips folded), Health History (last 7 days; each day's actions grouped into one line), check-in shows the points it earns. Menu items say what is inside ("How am I today?").
- [x] Alert wording: the machine-learning rule and the resting-heart-rate rule no longer print σ or model scores (rules v1.1.0); this also removes the "n/aσ" text when a value was missing.

**Done when:** a crew member can tell from Home in a few seconds whether they are OK and what to do next, no astronaut screen shows statistics jargon, the assistant's first sentence answers the question, and the checks pass in both themes. **Done 2026-11-15:**
- **Checks:** new browser test T-UI-10 (Home words, quests, 6 body tiles, no σ; theme switch remembered; assistant short answer ≤ 40 words with steps and folded details); the accessibility scan now also runs 6 pages in the dark theme; backend assistant tests check the short answer and that no σ is used; the existing browser tests were updated to the new wording. Full backend and browser suites pass; `tsc`, `oxlint`, `ruff`, `mypy` clean.
- A light-theme green failed contrast on its own tint (4.38:1); darkened to `#166534`.

**Not covered:**
- Messages saved before this change still show the old long answer (with σ) in the assistant history.
- Alerts raised before the rule change keep their old technical reason text; new alerts use the plain wording.
- The check-in, trends charts and reports pages keep their previous layout (they were already step-by-step or are mainly used by the flight surgeon).

---

### Step 15 — Connect a real smartwatch ✅

**Goal:** test the system with real readings from the astronaut's own watch (here a Fire-Boltt BGR002, paired with an Android phone). Fire-Boltt has no public data API and Health Connect has no web API, but the watch offers the standard Bluetooth **Heart Rate** service (checked with nRF Connect), so the browser can read it directly with Web Bluetooth: nothing to install. Details: LLD §15.8 (Smartwatch).

- [x] Heart-rate parser (`lib/heartRate.ts`): Bluetooth Heart Rate Measurement (0x2A37): 8- and 16-bit rate, skin contact, energy field, RR intervals; readings off the wrist, 0 bpm or out of range are ignored; median against single wrong beats.
- [x] Connection (`lib/watch.ts`): **Connect watch** in the header opens Chrome's device chooser (all devices listed, because many watches do not announce the service before connecting), subscribes to heart-rate notifications, reconnects 3 times after a drop, plain-language errors (no Bluetooth, not your watch, the watch still busy with the phone). The connection stays while moving around the app.
- [x] Saving (`lib/watchRecorder.ts`): while connected, one `heart_rate` reading a minute (median of that minute, at least 5 beats) is saved as a **Wearable** reading (`deviceId` `WATCH:<name>`) through the offline outbox and the normal intake, so it gets the personal normal, the rules, the timeline and Earth sync.
- [x] Check-in: **Measure with my watch (30 s)** on the resting-heart-rate step fills in the median of 30 s at rest; the astronaut sees and can change the value before sending. Exercise coach: live heart rate under the rep counter.

**Done when:** a real watch connects from Chrome, its heart rate shows live, a reading a minute reaches the health record, and the check-in can take its resting heart rate from the watch. **Done 2026-11-15:**
- **Checks:** unit T-W-01 (`npm run test:unit`: 6 parser tests from the Bluetooth byte layouts); browser T-UI-11 with a simulated Bluetooth watch sending real watch bytes: connect, live 64 bpm, a saved reading found through the measurements API, connection kept across pages, 30 s check-in measurement fills 64, disconnect.
- Works in Chrome or Edge on a laptop with Bluetooth, on `localhost` (or https). Not in the Claude app's built-in browser.

**Not covered:**
- **Only heart rate.** Blood oxygen, sleep, steps and blood pressure on this watch use Fire-Boltt's private protocol and are not readable; they still come from the check-in. Health Connect (an Android app) would be the route for sleep and steps.
- The watch talks to one device at a time: Bluetooth on the phone (or the Fire-Boltt app) must be off while it is connected to the laptop.
- Tested with the simulated watch only; the connection with the real FB BGR002 is to be confirmed by the user.
- Watch readings are real data next to simulated mission data for the same astronaut; the personal normal mixes both at first.

---

### Step 17 — Gemini as the assistant's online model ✅

**Goal:** let the team use Google Gemini (free key from Google AI Studio) instead of Claude, without changing the safety design.

- [x] `providers/common.py`: what both models share (instructions, JSON answer format, conversation, report prompt, `LlmAnswer`, `ProviderError`). `providers/claude.py` uses it unchanged.
- [x] `providers/gemini.py` with the official `google-genai` SDK (pinned `>=2.34,<3`; 2.34.0 released 2026-10-29): `generate_content` with the system instruction, `response_mime_type` JSON and `response_json_schema`, thinking level low, 45 s timeout; blocked (safety, prohibited, recitation…) or cut-off answers and any API or network error raise `ProviderError`; the report narrative too.
- [x] Service: `ASTRA_LLM_PROVIDER` auto (Claude if its key is set, else Gemini, else template), claude, gemini or template; the same guard, one retry with a reminder, then the template. Settings `GEMINI_API_KEY`, `ASTRA_GEMINI_MODEL` (default `gemini-3.8-flash`, the current stable Flash model).
- [x] Screen: the badge says "Earth relay · Gemini"; "Answer offline only" works for either model; a neutral note when the online model was unavailable. Status API adds `llmConfigured`, `geminiConfigured`.

**Done 2026-11-15:** backend T-AI-05 (9 tests with a simulated Gemini, and one through the API); the tests switch both keys off so they never call a real model. Full backend suite passes; `ruff`, `mypy`, `tsc`, `oxlint` clean.

**Not covered:** no call to the real Gemini API was made (no key on the development laptop); the first real answer is to be checked with your key. On Google's free tier, prompts may be used to improve Google's products: fine for simulated data, not for real health data.

---

### Step 18 — "Install app" button ✅

**Goal:** the app was installable (PWA) only through the browser's own menu, which most people never find. Add a clear button.

- [x] `lib/install.ts`: the browser's `beforeinstallprompt` offer is caught at startup (before React renders; it can arrive early) and kept; `installApp()` shows the browser's install dialog; `appinstalled` and `display-mode: standalone` mark the app as installed. Safari on iPhone and iPad has no such offer, so it is detected separately.
- [x] `InstallButton`: in the header (all roles) and under the sign-in form, **always visible until the app is installed**. With the browser's offer it opens the install dialog; without it, it shows where install is in this browser's menu (Chrome, Edge, Android), Safari's Share → Add to Home Screen steps (iPhone, iPad), or "use Chrome or Edge" (Firefox on a computer).
- [x] Installable on the dev server too (`devOptions` in `vite.config.ts`): before, the manifest was only linked in a production build, so on `localhost:5173` Chrome never offered installation and the button (then shown only with an offer) stayed hidden.
- [x] Proper install icons: 192 and 512 px PNGs, a maskable 512 px icon (logo inside the safe zone) and an Apple touch icon, generated from the logo; manifest, `theme-color` and Apple title in `index.html`.

**Done 2026-11-15:** browser test T-UI-12 (5 tests: no offer → menu steps, then offer → dialog → hidden once accepted; declined → stays and opens the dialog when offered again; already installed → no button; iPhone Safari → Add to Home Screen; Firefox → use Chrome or Edge). Full browser suite passes (44) with the development service worker on. The sign-in and Home pages still pass the accessibility scan. `tsc`, `oxlint`, `vite build` clean.

**Not covered:** the real Chrome install dialog and the iPhone home-screen icon were not tried on a device (test browsers never offer installation; the event is simulated).

### Step 19 — Works without internet ✅

**Problem:** signed in as an astronaut, turning off Wi-Fi showed "You are offline" and the app stopped loading screens and saving, even though the Habitat server (the spacecraft's computer; in the demo, this laptop) was still running. On a spacecraft the internet is the exception, so this broke the main idea.

**Cause:** TanStack Query's default `networkMode: 'online'` pauses every request while the browser reports no internet (`navigator.onLine` false), and the banner used the same signal.

- [x] `main.tsx`: `networkMode: 'always'` for queries and writes: requests always go to the Habitat; only a real failure to reach it counts as offline (the outbox and the saved screens still cover that case).
- [x] `OfflineBanner`: two different messages. **Habitat server not reachable** (yellow; checked every 15 s with `/api/system/status`): saved screens and the number of items waiting. **No internet** (neutral): "Everything on board keeps working. The AI assistant uses its offline answers until the internet is back."
- [x] Assistant: after a failed connection to Claude or Gemini (`NoConnectionError`), the online model is skipped for 60 s (`OFFLINE_PAUSE_S`), so only the first question waits for the network and the rest are answered from the offline template at once.
- [x] Already on board, unchanged: rules, baselines, ML insights (Isolation Forest, trend test), red-flag router, exercise coach (MediaPipe files served locally), emergency procedures, check-in outbox.
- [x] `apps/web/dev-dist/` (generated by the PWA plugin on each dev run) is now git-ignored.

**Done 2026-11-15:** browser test T-UI-13 (internet reported off while the Habitat runs: "No internet" note, no "server not reachable", water logged and shown, My Health loads, coach plan loads, assistant answers). Backend test T-AI-07 (connection error → template; next question offline at once without calling the model; model used again after the pause). Full suites pass: backend 293, browser 45, unit 14. `ruff`, `mypy`, `tsc`, `oxlint` clean.

**Not covered:** the hosted Vercel/GCP version needs the internet by nature: offline use needs the Habitat server on the same computer or local network (the spacecraft setup). The test simulates "no internet" in the browser; a real Wi-Fi-off run was not automated.

### Step 20 — Medication Guide ✅

**Goal:** on a Mars mission the crew can't reach a doctor in time (up to ~20 minutes one way, plus blackouts), so they must treat common problems with the onboard kit themselves (Earth-independent medical operations). The app tells them **which medicine, how much and when**, safely. The AI never chooses a medicine or a dose: they come from the flight surgeons' medicine list and fixed checks, and the crew medical officer (CMO) confirms.

- [x] `protocols/medications.json` (formulary, versioned, `status: demo`): 9 kit medicines (acetaminophen, ibuprofen, meclizine, diphenhydramine, loratadine, oxymetazoline spray, PEG 3350, loperamide, hydrocortisone 1%) with dose, larger first dose, interval, 24-hour limit, days limit, allergy groups, conditions to avoid (block or caution), interactions (regular medicines or medicine groups taken in the last 24 h), stock, expiry, drowsiness, kit drawer and the DailyMed label it comes from; 10 conditions with safety questions (red flags → emergency procedure or "call the CMO"), things to try first, medicines in order and the follow-up time. Loaded and cross-checked at startup like the other protocols. New emergency procedure `EMG-SEVERE-ALLERGY` and an assistant red flag for it.
- [x] `astra/core/medication.py` (pure): red flags first; then per medicine: allergy, conditions, interactions, a dose already waiting, interval, 24-hour limit (with the time it becomes possible), days in a row, stock (empty → block, low → caution), expiry (caution: may be weaker, an HRP risk on long missions), drowsy (no EVA or rover driving). The first option that is not blocked is recommended.
- [x] Tables `MedicalProfile` (allergies, conditions, regular medicines as vocabulary codes; seeded; edited by the CMO or flight surgeon) and `MedicationDose` (Requested → Confirmed / Declined / Cancelled → Taken → outcome; review). Both sync both ways (state order and first-non-null for doses, newest edit for profiles).
- [x] API `astra/api/medication.py`: formulary (with stock left), profile get/put, advice, doses (ask, CMO confirm or decline, confirm alone with a reason, taken, cancel, outcome, surgeon review). Every write re-runs the checks on the server. Doses are given only on the Habitat node; reviews and profile edits work on both.
- [x] Assistant: medicine questions ("what can I take for…") start with a fixed line pointing to the Medication Guide and return a `medicationGuide` link (matched condition). The guard now lets through **only** a dose the CMO confirmed in the last 24 h (`findings.approvedMedication`): its exact dose text and medicine; any other dose or medicine is still rejected.
- [x] Web: **Medicines** in the astronaut menu (choose the problem → yes/no questions → try first → recommended medicine with dose, when, how, drawer and cautions → ask the CMO or confirm alone; other medicines with the reason they are blocked and when they become possible; "Waiting for you": take it now, did it help?; history). CMO queue (Confirm / Decline with a reason) with a toast on new requests. Flight surgeon: "Medicines to review" on the crew overview, a Medicines tab per astronaut (review with a note, edit the profile), a toast when an astronaut feels worse.

**Done 2026-11-16:** backend tests T-MED-01..11 and T-AI-08 (formulary references; red flags stop; allergy and conditions pick the next safe medicine; interactions; interval and 24-hour limit with the next time; days, stock, expiry, pending; dose sizes; question → condition; API roles and the whole path; decline, cancel, confirm alone; assistant link and confirmed dose only; two-node sync of doses, reviews and profiles). Browser test T-UI-14 (3 tests: ask → CMO confirms → take → surgeon review, with the allergy block; a "yes" stops the guide; the assistant sends to the guide). Accessibility scan of the new pages. Full suites pass: backend 312, browser 52, unit 14. `ruff`, `mypy`, `tsc`, `oxlint`, `vite build` clean.

**Not covered:** the doses are **demo values** from US over-the-counter labels, not a flight-surgeon-approved formulary, and no prescription-only medicines are included. No weight- or age-based dosing (adults only), no pregnancy checks, no kidney/liver dose changes beyond blocking or a caution. In the browser test the flight surgeon's review is sent straight to the Habitat (the test runs no Ground node); the two-node path is covered by the backend sync test.

---

### Step 21 — Treatment at check-in and Act Now ✅

**Goal:** on Mars, Earth can be up to ~44 minutes away for a round trip, so the crew must act on a critical problem at once. At check-in the system decides how serious it is and what to do; for a critical problem it gives the exact steps and doses from approved protocols, with nothing waiting for the ground. **Design rules:** one source of truth (protocol files), same input → same answer (fixed rules, no AI in the decision), every decision explains itself, act first and tell Earth after, it keeps working with things broken, information before looks, nothing is lost.

- [x] **21a Protocols.** `protocols/treatments/TX-*.json`: 7 critical protocols (low blood sugar, chest pain, severe allergic reaction, stroke signs, low oxygen, high fever, severe bleeding): triggers (alerts, symptoms with a minimum severity, vital thresholds), ordered steps (action, medicine with alternatives, yes/no question, recheck with a timer and a repeat limit, measurement), "do not give" rules (a medicine, a group such as NSAID, or a route such as "nothing by mouth"), pre-approved overrides (an expired epinephrine injector is still given), escalation, approval block (`demo`). `routine.json` links mild/moderate symptoms to Medication Guide conditions. Emergency kit added to `medications.json`: glucose tablets, glucagon, chewable aspirin, epinephrine auto-injector (route, appearance, prescription flag). New check-in symptom "allergic reaction" (it also fixes the Step 20 red flag that reused "breathing difficulty"). Load-time validation refuses: unknown steps, medicines, rules, symptoms, indicators or procedures; a dose above one dose or the 24-hour limit; a loop without a repeat limit; a missing "do not give" section.
- [x] **21b Engine** `core/treatment.py`: matches protocols, merges several problems into one plan (most urgent first; every "do not give" applies to every step; each medicine once; earlier picks count for interactions), runs the Medication Guide checks on each medicine (allergy, conditions, interactions, interval, 24-hour limit, days, stock, expiry), applies pre-approved overrides, and explains everything (what matched, which medicine, why others were not used). Tiers: 1 mild and 2 needs treatment → Medication Guide (CMO confirms); 3 critical → Act Now.
- [x] **21c Episodes and API** `api/treatment.py`: the check-in returns the decision; `TreatmentEpisode` (plan snapshot, status, review) and `TreatmentEvent` (append-only log: steps, answers, rechecks, doses with who gave and who checked them, end). A dose given is always recorded (it happened) and also becomes a Medication Guide dose (intervals, limits, stock), with flags when the checks disagree. Rechecks and measurements become readings in the health record. Evidence already treated (an alert, symptom or reading from before a finished treatment) does not reopen it; at check-in only that check-in's symptoms count. Synced with urgent priority.
- [x] **21d Act Now** (`/astronaut/act`): one step per screen in big text; the dose card says what to do, how much, what it looks like and where it is; a second person checks the dose (or "no one else is here"); recheck countdowns with a beep; repeat doses blocked until the minimum interval; read aloud; **Help now** (red button on every astronaut screen) for anyone in the crew; **crew alarm** on every other crew device until silenced; any device can continue a treatment started elsewhere.
- [x] **21e Server down**: a TypeScript copy of the engine (`lib/treatment/engine.ts`) with the protocols bundled into the app; the astronaut's profile, doses, stock and the latest protocols are kept on the device; a check-in saved offline still opens Act Now; every action is stored on the device first and sent once; a reload resumes at the same step. **Both engines run the same 32 clinical cases** (`protocols/treatments/cases.json`).
- [x] **21f Earth**: Treatments tab per astronaut (full log, flags, review) and "Treatments to review" on the crew overview; **protocol updates from Earth**: checked on Earth, signed with the sync key, checked again on board, used for new treatments only.

**Done 2026-11-16:** backend tests T-TX-01..11 (32 clinical cases; 400 random situations: never an allergy, never a "do not give", never over a 24-hour limit, each medicine once, deterministic; broken files refused; API, roles and the full log; crew visibility; rechecks as readings; no reopening on old evidence; two-node sync of episodes, doses and reviews; a signed update used on board, a tampered one ignored). Web unit test T-TX-10 (the device engine on the same 32 cases). Browser drills T-UI-15 (check-in with glucose 45 → Act Now in under 5 s → exact dose, early repeat blocked, glucagon with a second check, rechecks → full log on the server; Help now → crew alarm on another device → continued there; server down → plan on the device → reload resumes → log sent once). Accessibility scan of the new screens. Full suites pass: backend 354, browser 58, unit 47. `ruff`, `mypy`, `tsc`, `oxlint`, `vite build` clean.

**Revision 2026-11-16 (self-rescue):** the emergency flow was too long for one person in trouble. Protocols v1.1.0 are written to the person ("Chew…", "Inject … into your outer thigh"), with 4–8 steps instead of 6–9 and no "call the CMO" steps: the crew alarm and the report to Earth start automatically, and the screen says so. Help now is one tap for yourself (someone else is optional); the server has 2.5 s to answer, then the device decides. Each step has one big **Done**; "I can't…" is a small link; the second-person dose check is gone (a dose taken alone is normal, not flagged); a protocol that ends well goes straight on. Actions are sent strictly in order (the treatment before its first step), which also fixed a race where an early step could be rejected and lost. The 32 clinical cases pass unchanged (same medicines and safety rules).

**Not covered:** the protocols and doses are **demo values** (public labels and first-aid guidance), not approved by a flight surgeon. Someone who is unconscious cannot treat themselves (for example glucagon when not awake): the automatic crew alarm covers that, and without the server it needs someone nearby. Adults only; no weight-based dosing. Conditions that need a diagnosis on board (appendicitis, fractures) are not included. Voice commands were not added (speech recognition in browsers needs the internet); steps are read aloud with the device's own voice. The crew alarm needs the Habitat server; with it down, call out loud. No dedicated simulator scenario: the drills and the demo steps in the README show it.

## 4. Team split (3–4 people)

With one backend language, the split is by area rather than by runtime:

| Track | Owner | Steps |
|---|---|---|
| **Health brain & backend** (Python) | Person A | 1, 2 (DB/API), 3, 8 (backend), 9 (sync) |
| **Frontend** (React) | Person B | 4, 5 (UI), 8 (UI), 9 (PWA), 10 |
| **Data, ML & assistant** (Python) | Person C | 2 (simulator), 6, 7 |
| **Content, design & pitch** | Person D (or shared) | Knowledge base, protocol texts, UI design, 3D model, slides, video |

Solo? Follow the steps in order and skip Ollama, PostgreSQL, 3D (keep 2D) and the mission timeline.
Daily: 15-minute stand-up, merge to `main` at least once a day, small PRs, CI green.

---

## 5. Commands you'll use every day

First-time setup (from the repo root):

```bash
cd services/backend && uv venv --python 3.12 .venv && uv pip install --python .venv/Scripts/python.exe -e ".[dev]"
```

```bash
cd apps/web && npm install
```

Secrets: if `services/backend/.env` doesn't exist (e.g. on a teammate's machine), copy it from the template and fill in the values. Never commit `.env`.

```bash
cd services/backend && cp .env.example .env
```

Generate a random value for `ASTRA_JWT_SECRET`:

```bash
cd services/backend && .venv/Scripts/python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Run the Habitat backend (Swagger UI at http://localhost:8000/docs):

```bash
cd services/backend && .venv/Scripts/python -m uvicorn astra.main:app --reload --port 8000
```

Run the Ground backend (from Step 9) in a second terminal (PowerShell):

```bash
cd services/backend; $env:ASTRA_NODE_ROLE="Ground"; $env:ASTRA_NODE_ID="GND-MCC"; $env:ASTRA_DATABASE_URL="sqlite:///ground.db"; .venv/Scripts/python -m uvicorn astra.main:app --reload --port 8001
```

Run the web app (http://localhost:5173):

```bash
cd apps/web && npm run dev
```

Tests and checks:

```bash
cd services/backend && .venv/Scripts/python -m pytest
```

```bash
cd services/backend && .venv/Scripts/python -m ruff check astra tests
```

Packages you'll add later: Step 2 `alembic`; Step 3 `pyjwt bcrypt`; Step 4 (web) `openapi-fetch` + dev `openapi-typescript`; Step 9 (web) `vite-plugin-pwa`; Step 10 (web) `three @react-three/fiber @react-three/drei`.

---

## 6. Scope cut-lines (decide quickly when behind)

Cut in this order — the demo story survives every cut:

1. Mission timeline, voice input, wellness streaks
2. Ollama local LLM (the template provider already covers offline)
3. PostgreSQL for Ground (stay on SQLite)
4. 3D body (keep the 2D SVG body map)
5. Live external API calls (replay the cached fixtures only; the demo looks the same)
6. Isolation Forest (keep the trend test; say "ML layer in progress")
7. Separate Ground node (surgeon uses the Habitat node; simulate delay in the UI only)

**Never cut:** simulator, baselines, rule engine with evidence, check-in → alert flow, red-flag emergency card, safety disclaimers.

---

## 7. The 5-minute demo script

| Time | Scene | What judges see |
|---|---|---|
| 0:00 | Problem | "Day 120 on Mars. Earth is 14 light-minutes away and the link is in blackout." Link pill: 🔴 BLACKOUT |
| 0:30 | Morning check-in | Guided check-in: resting HR 96 is flagged as far above normal ("Measure again" / "Keep this value"); sleep 4.5 h, fatigue 8, mood 3; done in ~60 s |
| 1:15 | Detection | YELLOW alert appears live: *Fatigue & recovery pattern needs review*; evidence: sleep −3.1σ, resting HR 89 vs normal 64 |
| 1:45 | Context-aware | Switch to AST-003: the same 85 bpm is GREEN because their normal is 80 |
| 2:00 | Analytics | Sleep falls out of its baseline band while resting HR rises; the ML trend insight flagged it a day earlier |
| 2:30 | Assistant | "Why is my resting heart rate increasing?" → grounded answer citing the NASA sources, badge "Onboard (offline)". Then "I have chest pain" → instant emergency protocol card |
| 3:15 | My Health | Heart and circulation → what it does, how spaceflight affects it, readings vs normal, symptoms to watch for |
| 3:40 | Earth link | Flip the link UP → after the simulated 14-minute delay the report lands on the surgeon dashboard, exactly once |
| 4:10 | Surgeon | Surgeon reviews the evidence and sends an instruction; it arrives onboard after the return delay |
| 4:40 | Close | Rules decide, ML corroborates, LLM explains · offline-first · human in the loop · NASA 17-risk coverage |

---

## 8. Definition of done (every feature)
- [ ] Works with the simulated data and is labelled SIMULATED where data is shown
- [ ] Unit tests for logic in `astra.core`; scenario test if it touches alerts
- [ ] Works offline, or degrades with a clear message
- [ ] Role checks enforced server-side (FastAPI dependency)
- [ ] No "diagnosis" or medication language; illustrative thresholds labelled
- [ ] `ruff` clean, merged to `main`, CI green, demo still runs
