# ASTRA HEALTH — Technical Design Document (TDD)

**Product:** ASTRA HEALTH — Autonomous Astronaut Health Intelligence & Decision-Support Platform
**Document type:** Technical Design Document
**Version:** 1.1 (single Python backend — see ADR-13) · **Date:** 2026-11-14
**Related docs:** [02-High-Level-Design.md](02-High-Level-Design.md) · [03-Low-Level-Design.md](03-Low-Level-Design.md) · [04-Implementation-Plan.md](04-Implementation-Plan.md)

> **Safety statement (repeat this in the app, the README, and the pitch).**
> ASTRA HEALTH is a research/hackathon prototype for **clinical decision support**. It does **not** diagnose or replace a flight surgeon. Its Medication Guide (ADR-15) only follows a versioned medicine list, which in this repository is a **demo** (public over-the-counter label doses, not approved by a flight surgeon), and every dose needs the crew medical officer's confirmation. All thresholds in this repository are **illustrative** and must be replaced by values approved by aerospace medicine experts before any real use. All demo data is **simulated** and labelled as such.

---

## 1. Purpose and scope

### 1.1 Problem
Astronauts on long-duration missions face physiological and psychological risks from NASA's **5 Hazards of Human Spaceflight**: Space Radiation, Isolation and Confinement, Distance from Earth, Gravity Fields, and Hostile/Closed Environments. Real-time medical support from Earth is delayed (≈ 3–22 min one-way to Mars) or periodically unavailable.

Facts from the organizer-provided sources that shape this design:
- Mars is on average about 140 million miles away, and a Mars mission would take roughly **three years**, compared with about three days to reach the Moon. Resupply, instructions and medical care become hard to receive. → **offline-first, onboard decision support** (NASA HRP, *5 Hazards*).
- On Mars, crews would live at **three-eighths of Earth's gravity for up to two years**. → mission profile `gravityG = 0.38`, musculoskeletal and cardiovascular monitoring (NASA HRP, *5 Hazards*).
- NASA stresses that the hazards **do not act alone**: they can feed off one another and make each other's effects worse. → **multi-indicator (composite) rules** are a core feature, not an add-on (NASA HRP, *5 Hazards*).
- NASA tracks **17 specific risks** in three groups: human physiology, behavioral performance & human factors, and space radiation. → ASTRA HEALTH's coverage of each risk is stated honestly in §13 (NASA HRP, *Risks of Human Spaceflight*).
- **Neutrons make up about 30 % of the radiation on the ISS** and are especially damaging biologically. The CSA is funding an autonomous, continuously operating neutron monitor, the **Canadian Active Neutron Spectrometer (CANS)**. → radiation data is ingested **per channel** (total / charged / neutron) from autonomous dosimeters (CSA, *Monitoring radiation for astronaut health*, 2026-02-26).
- Deep-space crews face more time in weightlessness, more radiation, longer isolation, communication delays, and less ability to rely on Earth for emergency medical help (CSA, *Why do we conduct science experiments in space?*).

### 1.2 Goal
Turn raw health measurements into **understandable, explainable, actionable** health information that works **onboard and offline**, and delivers reliable store-and-forward reports to flight surgeons on Earth.

### 1.3 Objectives
| # | Objective | How we measure it in the prototype |
|---|---|---|
| O1 | **Prevention** — detect changes from a *personal* baseline before they become problems | Scenario tests: the Day-120 fatigue scenario raises an *Attention* alert within ≤ 2 simulated days of onset |
| O2 | **Response** — help the astronaut recognise concerning symptoms and follow approved procedures | Red-flag symptoms always route to a deterministic protocol card (100 % in test set) |
| O3 | **Explainability** — every alert shows its evidence | 100 % of alerts carry rule id, version, evidence values, baseline, and plain-language reason |
| O4 | **Autonomy** — core features work without Earth link | Demo with link "DOWN": entry, analysis, alerts, assistant (template/local mode) all work |
| O5 | **Medical oversight** — ground doctors get trustworthy reports | Envelopes queued during blackout arrive exactly once after link restore |

### 1.4 In scope (hackathon)
Astronaut app (P0 modules 1–7), Flight Surgeon dashboard (module 8), simulated sensors, rule + ML analysis, LLM explanation layer with RAG, offline storage and simulated Earth link, Body Explorer, Mission-control overview (light).

### 1.5 Out of scope / non-goals
- Real medical device certification, real hardware integration (simulated device adapters only; Web Bluetooth is a stretch goal).
- Diagnosing disease, predicting disease, recommending medication or dosages.
- Inferring bone density, immune function, or radiation-induced cellular damage from HR/sleep. Those come only from **scheduled assessments** entered as results.
- Production-grade security accreditation (we design for it, but don't certify it).
- Medical image analysis. Photos are stored and sent to the flight surgeon for a human to look at; the app never interprets them.

### 1.6 Coverage of the challenge brief
| The brief asks for | Where it is |
|---|---|
| A visual tool to assess one's own health | Home (status in words, something to pay attention to, key measurements vs your normal) |
| Guidance on treatment and improvement | My Guidance, emergency procedures, Wellness, "how to protect" per body system |
| Blood pressure, heart rate, blood sugar, body temperature, sleep, mood | All in the guided daily check-in (blood sugar and body mass since the gap fix), plus devices |
| Input by keyboard, mouse or camera | Typed values and sliders; camera photos in the check-in (FR-25); the camera exercise coach (FR-27) |
| When a result needs the crew or flight surgeons | Rules: Attention vs Urgent, escalation, reports and alerts synced to Earth |
| Clickable human figure | My Health: a realistic human figure (flat and 3D, see-through skin, organs inside), 7-part explanation per system |
| Different environments (station, rover, base) | 4 mission profiles (FR-26, LLD §8.1) |
| Prompts to measure as a routine | Daily check-in task with "Due" badge, routine tasks |
| Gamification | My progress and badges (FR-24) |
| Dynamic charts, colour coding | Trends; status colours always with an icon and a word |
| Simple instructions | How-to for every measurement, "What this means", AI assistant with sources |

---

## 2. Stakeholders and users

| Role | Interface | Main needs | Permissions |
|---|---|---|---|
| **Astronaut** (primary) | Astronaut app (tablet/laptop PWA) | Fast check-in, clear status, "what do I do now?", privacy | Own data only; acknowledge alerts; chat with assistant; private wellness notes |
| **Flight Surgeon** (secondary) | Surgeon dashboard (Ground node) | Trends, alerts, evidence, reports, send instructions | Read all crew data (except private notes), review/resolve alerts, send instructions |
| **Mission Control / Research** (supporting) | Mission overview | Crew-level status, environment, anonymised aggregates | Aggregates + status colours only, no raw medical detail |
| **Admin / Demo operator** | Demo control panel | Drive the simulation, toggle comms link, inject scenarios | Simulation and configuration only |

---

## 3. Requirements

### 3.1 Functional requirements (FR)
| ID | Requirement | Priority |
|---|---|---|
| FR-01 | Users authenticate and get a role (Astronaut, FlightSurgeon, MissionControl, Admin) | P0 |
| FR-02 | Astronaut can enter measurements manually (HR, BP, glucose, temp, SpO₂, weight) | P0 |
| FR-03 | Daily wellness check-in (sleep h, sleep quality, mood, stress, fatigue 1–10, symptoms) in < 60 s | P0 |
| FR-04 | Simulated devices stream readings (wearable HR/sleep/activity, dosimeter, cabin sensors) | P0 |
| FR-05 | Every reading is validated, unit-normalised, quality-flagged and timestamped with source | P0 |
| FR-06 | System maintains a personal baseline per astronaut × indicator | P0 |
| FR-07 | Deterministic rule engine evaluates single- and multi-indicator rules → GREEN / YELLOW / RED | P0 |
| FR-08 | Alerts are deduplicated, explainable, acknowledged, reviewed, resolved, and audited | P0 |
| FR-09 | Dashboard shows status, latest vitals vs baseline, active alerts, wellness index, today's tasks | P0 |
| FR-10 | Analytics: daily/weekly/monthly charts with baseline band and alert markers | P0 |
| FR-11 | Recommendations linked to alerts and to routine prevention (exercise, sleep, hydration, wellness) | P0 |
| FR-12 | AI assistant answers questions in plain language, grounded in curated knowledge + the user's validated findings, with citations | P0 |
| FR-13 | Red-flag symptoms bypass the LLM and show the emergency protocol card | P0 |
| FR-14 | ML anomaly/trend detection produces *insights* that can corroborate rules | P1 |
| FR-15 | Medical reports (daily/weekly/on-alert) generated and queued for Earth | P0 |
| FR-16 | Surgeon dashboard: crew list, astronaut drill-down, alert review, send instruction | P1 |
| FR-17 | Offline-first: tablet keeps working if habitat server unreachable; habitat keeps working if Earth link down | P0 / P1 |
| FR-18 | Store-and-forward sync Habitat ↔ Ground with simulated light-time delay & blackouts | P1 |
| FR-19 | Body Explorer: clickable body regions mapped to body-system data | P1 |
| FR-20 | Radiation dose tracking (daily + cumulative vs mission limit) and environment panel | P1 |
| FR-21 | Wellness Center: guided breathing, sleep routine, exercise plan, wellness missions | P1 |
| FR-29 ✅ | The astronaut's own smartwatch over Bluetooth (Step 15): live heart rate in the app, one reading a minute saved as a wearable reading, resting heart rate measured by the watch in the check-in, live heart rate in the exercise coach | P2 |
| FR-28 ✅ | Simple, calm crew screens (Step 14): every astronaut page answers its question first in everyday words (no statistics jargon), details folded; daily quests with points; short assistant answers (1–2 sentences, up to 3 steps); light and dark themes | P1 |
| FR-27 ✅ | Exercise coach (Step 13): today's resistance plan from the astronaut's condition (open alerts → rest day, lighter or more); on-device body tracking through the camera counts reps and sets, gives spoken posture tips and times rests; video never leaves the device; results recorded and synced to Earth; demo playback with a simulated person | P2 |
| FR-22 | Mission timeline (pre-flight → now) of measurements, alerts, interventions | P2 |
| FR-23 | Voice input for symptom reporting (Web Speech API) | P2 |
| FR-24 | Gamification: points, streaks, weekly goals and badges for health habits the astronaut controls, never for readings ✅ | P1 |
| FR-25 | Camera input: astronaut attaches photos (skin, eye, wound, device display) to the check-in for the flight surgeon; not analysed by the app ✅ | P1 |
| FR-26 | Mission environments: space station, Mars transit spacecraft, Moon rover, Mars base change the targets, link delay and health focus ✅ | P1 |

### 3.2 Non-functional requirements (NFR)
| ID | Category | Requirement |
|---|---|---|
| NFR-01 | Safety | Severity (GREEN/YELLOW/RED) is decided **only** by deterministic, versioned rules. ML and LLM can never raise to RED or lower a rule result. |
| NFR-02 | Explainability | Each alert stores rule id + version, input values, baseline, window, and generated reason. |
| NFR-03 | Availability | All P0 astronaut features work with Earth link DOWN. If the ML or LLM components fail (exception, timeout, no API key), rules, alerts and template explanations still work (graceful degradation). |
| NFR-04 | Latency | Measurement → alert visible on dashboard ≤ 2 s (local). Assistant first token ≤ 5 s (cloud), template answer ≤ 300 ms. |
| NFR-05 | Data integrity | Raw measurements are append-only and immutable; assessments are stored separately. Sync is idempotent (exactly-once effect). |
| NFR-06 | Security | JWT auth, role-based authorisation on every endpoint, TLS in transit, encrypted DB at rest (SQLCipher — P2), audit log for all reads of medical data by surgeons. |
| NFR-07 | Privacy | Private wellness notes are visible to the astronaut and (opt-in) psychological support only. Mission Control sees aggregates. |
| NFR-08 | Usability | Daily check-in ≤ 60 s; large touch targets (glove-friendly ≥ 48 px); WCAG AA contrast; colour is never the only signal (icons + text). |
| NFR-09 | Configurability | Mission profile (gravity, comms delay, radiation limit), rules and recommendations are data files, not code. |
| NFR-10 | Testability | Rule engine and baseline calculator are pure functions with ≥ 90 % unit test coverage; every rule has a positive and negative test. |
| NFR-11 | Honesty | All simulated data is labelled "SIMULATED"; UI never uses the word "diagnosis". |

---

## 4. Key architectural decisions (ADRs)

Each decision is short; the "why" matters more than the "what".

### ADR-01 — Modular monolith, not microservices
**Decision:** One **FastAPI** backend (Python package `astra`, organised by module) + one React app. Rules, baselines, ML and the assistant all live in the same backend, as separate modules.
**Why:** Hackathon time; two programs to run instead of three; no network hop between "API" and "AI"; modules have clear seams so they could be split later.

### ADR-02 — Two-node deployment: **Habitat node** (onboard) and **Ground node** (Earth)
**Decision:** The same API binary runs in two modes via config `Astra:NodeRole = Habitat | Ground`. A **Deep Space Link Simulator** sits between them with configurable one-way delay and blackout windows.
**Why:** This is what "offline-first" really means for a Mars mission: the crew's tablet talks to an **onboard server** on the spacecraft LAN, and *that server* is disconnected from Earth. It makes the store-and-forward story real and visually demonstrable (the surgeon literally sees data arrive late).
**Phase note:** Phase 1 runs only the Habitat node; the Ground node is added with the surgeon dashboard.

### ADR-03 — Hybrid intelligence with a strict authority order
```
Deterministic rules  >  ML insights  >  LLM explanation
(decide severity)      (corroborate,    (explain only,
                        never RED)       never decide)
```
**Why:** Safety and explainability. A life-threatening reading must never depend on a probabilistic model or an LLM's mood.

### ADR-04 — Rules as versioned JSON protocol files
**Decision:** Rules, recommendations and emergency protocols live in `/protocols` as JSON/Markdown, loaded at startup, each with `id` + semantic `version`. Each alert records the rule version that fired.
**Why:** Mirrors "medical protocol versioning"; doctors/judges can read rules without reading Python; changes are diff-able in git.

### ADR-05 — Personal baselines with robust statistics
**Decision:** Baseline = rolling median and scaled MAD (median absolute deviation) over a clean window, with a per-indicator minimum spread floor. Deviation expressed as a robust z-score.
**Why:** Robust to outliers and sensor glitches, explainable ("you are 2.4 σ above *your* normal"), cheap, no training needed. Directly implements "context-aware risk assessment" (85 BPM means different things for different astronauts).

### ADR-06 — ML = Isolation Forest + trend tests, per astronaut, as an in-process module
**Decision:** The `astra.ml` module runs (a) a multivariate daily-feature Isolation Forest per astronaut and (b) Mann–Kendall/Theil–Sen trend detection, in a worker thread after ingestion so requests never wait for it. Output is an **Insight**, not an alert. Any ML exception is logged and swallowed; rules are unaffected.
**As built (Step 6):**
- **Where it runs:** inside the assessment, before the rules, with a 10 s budget, so the corroboration rule sees the
  same day's score.
- **Trend:** runs on a combined recovery-strain score, because single-indicator trends were too noisy.
- **Measurements:** LLD §10.
**Why:** Small data per person (dozens of days) → unsupervised, lightweight, explainable-enough models. scikit-learn is fast to ship.

### ADR-07 — LLM provider abstraction with three tiers
| Tier | Provider | When |
|---|---|---|
| 1 | **Claude via Anthropic API** (`anthropic` Python SDK, model `claude-opus-5-5`, configurable via env) | Internet available (demo laptop / Ground node / "relay" mode) |
| 2 | **Local model via Ollama** (small open model) | Habitat node with no Earth link (stretch) |
| 3 | **Template provider** (deterministic text from findings + retrieved snippets) | Always available; the guaranteed fallback |

**Why:** The demo must work in a hall with bad Wi-Fi, and the story must be honest about Mars having no cloud. Tier 3 guarantees the assistant never "goes dark".
**As built (Step 7):**
- Tiers 1 and 3 are built; Claude is used whenever `ANTHROPIC_API_KEY` is set (the user can force "offline only").
- Any Claude refusal, error or guard failure falls back to tier 3.
- Tier 2 (Ollama) is not built.
- Red flags never reach any model.

**Step 17:** tier 1 can also be **Google Gemini** (`google-genai` SDK, model `gemini-3.8-flash`, `GEMINI_API_KEY`). Both models share one contract (`providers/common.py`: instructions, JSON answer, conversation) and the same guard, retry and fallback; `ASTRA_LLM_PROVIDER=auto` uses Claude if its key is set, else Gemini, else the template.

### ADR-08 — RAG over a curated, cited knowledge base; BM25 first
**Decision:** Curated Markdown notes (written by the team from NASA HRP / human-research-roadmap / NASA-STD-3001 public sources, with source URLs) chunked and indexed with BM25 (`rank_bm25`); embeddings (local `sentence-transformers`) are a Phase-2 upgrade.
**Why:** Fully offline, no model download, deterministic, good enough for ~50–200 chunks.

### ADR-09 — Data stores
| Store | Where | Why |
|---|---|---|
| **SQLite** (SQLModel / SQLAlchemy 2 + Alembic) | Habitat node | Embedded, zero-ops — realistic for spacecraft edge hardware |
| **SQLite** — *optionally PostgreSQL* | Ground node | Same code; Postgres only if you want a "central server" story |
| **IndexedDB** (Dexie) | Browser (PWA) | Tablet-level offline cache + outbox |
| Files (`joblib`) | Backend `models/` folder | Per-astronaut ML models |

Use SQLite everywhere. Switching Ground to PostgreSQL is only a change of `DATABASE_URL`; do it last, if at all.

### ADR-10 — Measurements are immutable events; IDs generated at the edge
**Decision:** Every record has a client-generated **UUIDv7** (time-ordered). Measurements are never updated; corrections are new records that reference the superseded id.
**Why:** Makes sync idempotent and conflict-free for 90 % of the data; preserves evidence (audit).

### ADR-11 — Real-time via FastAPI WebSockets
**Decision:** One WebSocket endpoint `/ws` with an in-process connection manager that supports groups (`astronaut:{id}`, `medical`, `mission`, `admin`). Messages are JSON `{type, payload}`.
**Why:** Built into FastAPI, no extra service; the browser's native `WebSocket` is enough on the client (with a small reconnect wrapper). Pushes `AlertRaised`, `MeasurementRecorded`, `InstructionReceived`, `LinkStatusChanged` to dashboards.

### ADR-12 — Frontend: React + Vite + TypeScript + Tailwind, TanStack Query, Zustand, Recharts, React Three Fiber, Dexie, vite-plugin-pwa
**Why:** Matches team skills; TanStack Query handles caching/refetch; Dexie gives a clean IndexedDB API; PWA gives installable offline app.

### ADR-13 — Stack choice: React + one FastAPI backend
Four stacks were compared on 2026-11-14:

| | A. React + ASP.NET Core + Python FastAPI | **B. React + FastAPI (chosen)** | C. React + Node (NestJS) + Python ML | D. React + Supabase/Firebase + Python function |
|---|---|---|---|---|
| Server programs | 3 | **2** | 3 | 2 + cloud |
| Build speed (30 days) | Medium | **Fastest** | Medium | Fast for CRUD |
| AI/ML fit | ML behind a network hop | **Best — one language for rules, baselines, ML, LLM** | Weak in JS | OK |
| Offline / Habitat–Earth story | Good | Good | Good | Poor (cloud-dependent) |
| Demo failure risk | Medium | **Lowest** | Medium | High |

**Decision:** B. **Consequences:** type safety comes from Pydantic models + `mypy` (or pyright) + `ruff`; deterministic logic stays in a pure `astra.core` package with no FastAPI or database imports, so it can be tested on its own (the same rule as the earlier C# Core project).

### ADR-14 — Real space-environment data, simulated crew physiology
**Context:** Real astronaut medical data is not public; NASA's Life Sciences Data Archive grants access only through formal research requests. Space-environment data, by contrast, is open.

**Decision:**
- **Crew physiology and wellness are simulated**, calibrated to published spaceflight numbers (LLD §20.4) and labelled SIMULATED everywhere.
- **The space environment uses real data** (all checked working on 2026-11-14):
  - **NASA DONKI**: real solar energetic particle (SEP) events, using the team's NASA API key.
  - **JPL Horizons**: real Earth–Mars distance and one-way light time (11.0 min on 2026-11-14), no key.
  - **NOAA SWPC GOES**: live proton flux, no key.
- **The Ground node fetches**, because Earth has internet. Space-weather notices then travel to the Habitat over the simulated deep-space link, so the crew's warning arrives one light-time late.
- **Every response is cached to fixture files**, so the demo runs fully offline and is reproducible (e.g. replaying the May 2024 storm).

**Why:** It's honest about data availability, it adds real NASA data to the demo, and it turns the "Distance from Earth" hazard into something visible.

**Not used:**
- Microsoft Planetary Computer hosts Earth-observation data, not space weather, Mars or human-health data. It needs no key for public data (a subscription key only raises rate limits). Optional use: an "Earth benefits" slide.
- NASA's InSight Mars weather API: the lander ended operations in 2022, so there is no current data.

### ADR-15 — Medication Guide: medicines and doses from a versioned list, never from the AI (Step 20)
**Context:** on a Mars mission a message to Earth takes up to ~20 minutes one way and blackouts last days, so the crew must treat common problems with the onboard kit on their own (Earth-independent medical operations).
**Decision:** a **formulary file** (`protocols/medications.json`) holds the kit medicines, doses, limits, allergy groups, conditions to avoid and interactions, plus the conditions with their safety questions. Fixed, tested checks (`core/medication.py`) pick the first medicine that is safe for this astronaut now; a red-flag "yes" stops the guide. The **crew medical officer confirms** every dose (or the astronaut alone, with a reason that the flight surgeon sees), and every dose syncs to Earth for review. The LLM keeps its rule *never choose a medicine or a dose*: it links to the guide and may only repeat a dose the CMO confirmed; the guard rejects any other.
**Why:** the same authority order as ADR-03: a dose must be checkable, versioned and approved by a physician, never generated. **Limit:** the list in this repository is a demo built from US over-the-counter labels; a mission replaces it with the flight surgeons' approved formulary.

### ADR-16 — Treatment at check-in and Act Now: act first, from signed protocols, on the device if needed (Step 21)
**Context:** a round trip to Earth can take ~44 minutes; a critical problem (low blood sugar, severe allergy, chest pain) cannot wait.
**Decision:** treatment protocols are data (`protocols/treatments/`): triggers, ordered steps with exact doses, rechecks with timers and repeat limits, "do not give" rules and an escalation. A deterministic engine (`core/treatment.py`) decides the tier at every check-in and builds one merged plan, explaining every choice; tier 3 opens **Act Now** at once. **The same engine runs on the device** (TypeScript copy, bundled protocols, cached profile), kept identical by one shared case file run against both. Every action is logged on the device first and sent to Earth with urgent priority; the flight surgeon reviews and can send **signed** protocol updates, which the Habitat checks before use. No AI in the decision.
**Why:** reliability over looks: one source of truth, same input → same answer, works with the server, the link or the internet down, and nothing waits for Earth. **Limit:** demo protocols and doses until a flight surgeon approves them.

---

## 5. Technology stack (final)

| Layer | Technology | Version guidance |
|---|---|---|
| Web app | React 18/19, TypeScript 5, Vite, Tailwind CSS, React Router, TanStack Query, Zustand, react-hook-form + zod | Latest stable |
| Charts / 3D | Recharts; three.js + @react-three/fiber + @react-three/drei | Latest stable |
| Offline (browser) | Dexie.js (IndexedDB), vite-plugin-pwa (Workbox) | |
| Real-time | FastAPI WebSockets (server), native browser `WebSocket` + reconnect wrapper (client) | |
| Backend | **Python 3.12, FastAPI, Uvicorn**, Pydantic v2 + pydantic-settings, SQLModel (SQLAlchemy 2) + Alembic, built-in OpenAPI/Swagger UI | |
| Auth | JWT bearer (PyJWT), bcrypt password hashing, role checks as FastAPI dependencies | |
| Analytics & AI (same backend) | pandas, NumPy, scikit-learn, pymannkendall, rank_bm25, `anthropic` SDK, httpx (Ollama, sync to peer) | |
| Code quality | ruff (lint + format), mypy or pyright (types) | |
| Databases | SQLite (habitat and ground); PostgreSQL optional for ground | |
| Simulator | Python CLI (Typer) with YAML scenarios | |
| Testing | pytest + FastAPI `TestClient` (backend), Vitest + React Testing Library (web), Playwright (1–2 e2e demo flows) | |
| Tooling | Git + GitHub, Docker Compose (optional), GitHub Actions CI (build + tests) | |

---

## 6. AI / analytics design summary

Full algorithms live in the LLD; this is the contract.

### 6.1 Pipeline
```
Reading → Validate & normalise → Store (immutable) → Update baseline stats
       → Rule engine (deterministic) → Alert manager (dedupe, state)
       → [async] ML insights (anomaly + trend) → attach to alert / insight feed
       → Recommendation engine (rule → actions) → Notify (WebSocket) → Outbox (sync)
       → [on demand] LLM explanation / assistant (RAG + findings JSON)
```

### 6.2 Severity semantics
| Level | Colour | Meaning | Who can set it |
|---|---|---|---|
| NORMAL | GREEN | No current concerning findings | Default |
| ATTENTION | YELLOW | Unusual reading or developing trend; recheck & follow guidance | Rules (incl. multi-indicator rules, which may use ML insight as one condition) |
| URGENT | RED | Mission-defined critical threshold or red-flag symptom; follow emergency protocol and contact medical support | **Rules only**, from absolute critical limits or red-flag symptoms |

### 6.3 Data-quality gate
A reading with `quality = Questionable` can't create an alert by itself; it creates a **"Recheck"** task. `Rejected` readings are stored (for audit) but excluded from analytics. RED thresholds on a single questionable reading → "Recheck immediately" task with RED styling *and* the emergency card if a red-flag symptom accompanies it (safety over false-alarm aversion).

### 6.4 Wellness index (0–100)
A transparent weighted index of domain sub-scores (cardiovascular, sleep, behavioural, activity, metabolic, environment/radiation), **capped** by active alerts (RED ⇒ ≤ 40, YELLOW ⇒ ≤ 75). Always labelled "wellness index — not a clinical score".

### 6.5 LLM usage rules
1. Input to the LLM = the user question + **validated findings JSON** (latest values, baselines, active alerts with evidence) + retrieved knowledge chunks with ids.
2. The LLM must not change severity, must not diagnose, must not give medication/dosage advice, must cite chunk ids, must say "contact your flight surgeon" when an alert's escalation criteria are met.
3. Output is structured (answer, citations[], suggested_actions[], safety_flags[]) using Claude structured outputs (`output_config.format`), then post-filtered.
4. Red-flag detector runs **before** the LLM; if triggered, the LLM is not called.
5. Use adaptive thinking with **low effort** for chat responsiveness; enable the server-side refusal **fallback** option recommended for current Claude models; handle `stop_reason == "refusal"` by returning the template answer.
6. API key only in server environment (`ANTHROPIC_API_KEY`), never in the browser.

---

## 7. Security & privacy design

| Concern | Design |
|---|---|
| Authentication | `/api/auth/login` → JWT (60 min) + refresh token; seeded demo users per role |
| Authorisation | FastAPI dependencies: `require_self_or_medical` (resource owner), `require_role("FlightSurgeon")`, `require_role("MissionControl")`, `require_role("Admin")`. Checked on every route, not only in the UI |
| Data minimisation | Mission Control endpoints return status colours/aggregates only |
| Private notes | `WellnessAssessment.PrivateNote` encrypted field; surgeons can't read it |
| Encryption in transit | HTTPS (dev cert), WSS for WebSockets, sync envelopes signed with HMAC-SHA256 |
| Encryption at rest | P2: SQLCipher for SQLite; IndexedDB data is cache only and cleared on logout |
| Audit | `AuditLog` table: who, what, when, entity, action (create/read-medical/ack/resolve/instruct) |
| Secrets | `services/backend/.env` (git-ignored) holds `ASTRA_JWT_SECRET`, `ASTRA_NASA_API_KEY`, `ANTHROPIC_API_KEY`; `.env.example` (committed) lists the names with empty values. Keys are read only by the backend, never sent to the browser |
| LLM data | Send only the minimum context; no names (use astronaut code e.g. `AST-001`) |

---

## 8. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Scope explosion (15 modules) | High | Vertical slices; strict phase cut-lines (see Implementation Plan §6) |
| False alarms annoy users / judges | Med | Persistence rules (2-of-3), quality gate, personal baselines, scenario test suite measuring false-alarm rate |
| LLM hallucination / unsafe advice | High | Authority order, red-flag bypass, structured output + post-filter, citations, template fallback |
| Wi-Fi fails during demo | High | Template provider + optional Ollama; whole stack runs on one laptop; recorded backup video |
| External data API down, rate-limited or changed (e.g. the DONKI flare endpoint returned 404 on 2026-11-14) | Low | Only SEP events are relied on; all responses cached as fixtures; the app runs with no keys at all |
| 3D body eats days | Med | Build 2D SVG body map first (same data contract), upgrade to 3D only in Phase 2 |
| Sync complexity | Med | Immutable events + idempotent upserts + simple state-machine merge for alerts |
| Team unfamiliar with Python ML | Low | ML is a thin optional layer; system works without it |
| Medical credibility questions from judges | Med | Disclaimers, cite NASA sources, "illustrative thresholds" labels, human-in-the-loop design |

---

## 9. Testing strategy

| Level | What | Tooling |
|---|---|---|
| Unit | Validation, unit conversion, baseline, rule engine, wellness index, alert state machine, sync merge | pytest (`astra.core` has no I/O, so tests are fast) |
| Scenario ("golden") tests | Simulated 120-day crews: *healthy*, *fatigue onset*, *fever*, *radiation SPE*, *sensor glitch*, *missing data* — assert expected alerts and **no** unexpected alerts | pytest, calling the simulator's generator directly |
| Contract | FastAPI's OpenAPI spec; generated TS client compiles | openapi-typescript |
| AI | Red-flag detector precision on a phrase list; assistant refuses diagnosis/dosage prompts; citations present | pytest |
| E2E | Demo script: check-in → alert → assistant → report → surgeon sees after delay | Playwright |
| Offline | Kill API → enter check-in on tablet → restore → data synced once; link DOWN → envelopes queued → UP → delivered once | Manual + Playwright |

**Prototype evaluation metrics** (report these in the pitch): scenario detection rate, false-alarm count on the healthy crew, median time-to-detection (sim days), check-in completion time, % alerts with full evidence, sync duplicates (target 0).

**Measured (simulated ARES-1 mission and healthy crew, seed 42).** Reproduce with `python -m astra.evaluate`; the full report is [`docs/evaluation/EVALUATION.md`](evaluation/EVALUATION.md) (Step 11).

| Metric | Result |
|---|---|
| Scenario detection | 2 / 2 injected episodes detected (fatigue, solar storm); the sensor glitch was correctly *not* alarmed |
| Time to detection | Fatigue (onset day 114, ramping over 5 days): heart-rate alert day 116, composite alert day 117. Solar storm: same day (87) |
| False alarms, healthy crew (120 days) | 4 Attention alerts across 3 astronauts (1 / 1 / 2), 0 Urgent; budget ≤ 2 per astronaut. Unchanged after Step 5 added 10 rules (16 total): the new rules add 0 false alarms after the glucose rule was made repeat-confirmed |
| ML trend lead time (Step 6) | Recovery-strain trend insight on day 115: 1 day before the heart-rate alert, 2 before the composite. 0 trend insights and 0 ML alerts for the healthy crew |
| Habitat → Earth latency (Step 9) | Alerts + report on the Ground copy 24.4 s after the link came up (22 s = 11.0 light-minutes × 2 s compression, + ≤ 2 s loop); the instruction back onboard in ≈ 23 s; 0 duplicates after re-delivery |
| Alerts with full evidence | 100 % (every alert stores rule id + version, values, baseline, σ, z and a rendered reason) |
| Duplicate readings stored on re-import | 0 of 6,649 |
| Check-in completion time | 38 s by hand in the browser (target < 60 s); the Playwright demo path asserts < 60 s on every run |
| API speed, 150 days × 3 crew (Step 11) | Dashboard 47 ms, body systems 49 ms, mission analytics 52 ms, 7-day report 64 ms, crew summary 270 ms (median of 5; target < 1 s) |
| Accessibility (Step 11) | 0 serious / critical axe-core WCAG 2.1 AA violations on 10 pages |

---

## 10. Deployment (hackathon)

- **Local dev / demo:** everything on one laptop: `web` (5173), `backend` in Habitat mode (8000), `backend` in Ground mode (8001), optional `ollama` (11434). Plain `uvicorn` / `npm run dev`, plus a `start-demo.ps1` that launches all of them.
- **Public demo (optional):** Web on Vercel/Netlify; backend on Render/Railway/Fly.io (one Docker image, run twice with different `NODE_ROLE`). Not required to win; a local demo is safer.

---

## 11. Glossary
| Term | Meaning |
|---|---|
| Baseline | Personal normal for an indicator (robust median ± spread) |
| Robust z | (value − median) / (1.4826 × MAD), floored |
| Insight | ML/trend signal; informational, cannot set severity by itself |
| Alert | Rule-generated finding with severity, evidence, state |
| Envelope | Batch of records sent over the simulated deep-space link |
| Sol | Martian day (24 h 39 min); UI shows Mission Day / Sol |
| Habitat node | Onboard server (spacecraft LAN) |
| Ground node | Earth-side server for flight surgeons |

## 12. References

### 12.1 Hackathon-provided resources (primary — cite these first)
| Source | Used for |
|---|---|
| NASA HRP — *5 Hazards of Human Spaceflight* — https://www.nasa.gov/hrp/hazards/ | Hazard model, hazard interaction, mission facts (distance, duration, 3/8 g) |
| NASA HRP — *Risks of Human Spaceflight* — http://nasa.gov/hrp/risks/ | The 17 risks; coverage matrix (§13); knowledge-base topics |
| NASA HRP — *Ongoing HRP Research* — https://www.nasa.gov/hrp/ongoing-hrp-research/ | Precedents: ARCHeR actigraphy (sleep, activity, light), Standard Measures, Immune Biomarkers, B-Complex & Thigh Cuff (SANS countermeasures), Zero T2 (exercise), Tempus Pro (telemedicine) |
| CSA — *Monitoring radiation for astronaut health* (2026-02-26) — https://www.asc-csa.gc.ca/eng/news/articles/2026/2026-02-26-monitoring-radiation-astronaut-health.asp | Neutron radiation (≈ 30 % of ISS radiation), CANS autonomous neutron spectrometer, earlier bubble detectors |
| CSA — *Why do we conduct science experiments in space?* — https://www.asc-csa.gc.ca/eng/iss/science/why-do-we-conduct-science-experiments-in-space.asp | Deep-space risk framing, Earth benefits (§14) |

### 12.2 Data APIs (ADR-14)
| API | URL | Key | Used for |
|---|---|---|---|
| NASA DONKI — SEP events | `https://api.nasa.gov/DONKI/SEP?startDate=…&endDate=…&api_key=…` | NASA API key (free, api.nasa.gov; 1,000 req/h) | Real solar-particle events → radiation scenario and shelter alerts |
| JPL Horizons | `https://ssd.jpl.nasa.gov/api/horizons.api` (Mars `499` observed from Earth `500@399`, quantities `20,21`) | None | Earth–Mars range and one-way light time → link delay |
| NOAA SWPC GOES integral protons | `https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json` | None | Live ≥10 MeV proton flux → "space weather now" panel |

### 12.3 Calibration references for the simulator (verify before quoting)
- Barger L.K. et al., *Lancet Neurology* 2014: astronauts average about 6 h of sleep per night in flight.
- NASA (widely cited): weight-bearing bone loss of about 1–1.5 % per month in microgravity.
- Zeitlin C. et al., *Science* 2013: about 1.8 mSv/day during Mars cruise (Curiosity RAD).
- Hassler D.M. et al., *Science* 2014: about 0.64 mSv/day on the Mars surface (Curiosity RAD).
- NASA-STD-3001: career effective dose limit of 600 mSv.

### 12.4 Supporting references
- NASA Human Research Program — https://www.nasa.gov/hrp/
- NASA Human Research Roadmap (risk details, Exploration Medical Capability) — https://humanresearchroadmap.nasa.gov/
- NASA-STD-3001 Space Flight Human-System Standard — https://www.nasa.gov/ocho/std-3001/

---

## 13. Coverage of NASA's 17 spaceflight risks

Being explicit about what the prototype does **not** do is part of the safety design (and what judges will ask). Levels: **Monitored** = data + rules + guidance · **Partial** = symptoms, scheduled assessments or proxy indicators only · **Out of scope** = needs equipment or expertise beyond the prototype.

| # | NASA risk | Group | ASTRA HEALTH coverage | How |
|---|---|---|---|---|
| 1 | Altered Immune System Responses | Physiology | Partial | Body temp, illness symptoms, stress; composite rule *stress ↑ + temperature ↑* (NASA notes stress can reactivate dormant viruses); immune panel as a scheduled assessment |
| 2 | Altered Sensorimotor & Vestibular Function | Physiology | Partial | Dizziness / motion-sickness / coordination symptoms; scheduled balance assessment |
| 3 | Cardiovascular Adaptations | Physiology | **Monitored** | HR, resting HR, BP vs personal baseline; CV rules; orthostatic symptoms |
| 4 | Decompression Sickness | Physiology | Out of scope | Post-EVA symptom logging routes to the emergency protocol only |
| 5 | Host-Microorganism Interactions | Physiology | Out of scope | Needs microbiome sampling; GI symptoms are logged |
| 6 | Hypoxia | Physiology | Partial | SpO₂ rules, cabin CO₂ warnings |
| 7 | Inadequate Food and Nutrition | Physiology | Partial | Body weight, hydration, glucose, nutrition logs and reminders |
| 8 | Injury & Compromised Performance from EVA | Physiology | Partial | EVA log (P2), fatigue and workload context, SpO₂ / CO₂ |
| 9 | Reduced Cardiorespiratory & Musculoskeletal Fitness | Physiology | **Monitored** | Exercise adherence, strength index, activity, resting HR trend |
| 10 | Spaceflight Associated Neuro-ocular Syndrome (SANS) | Physiology | Partial | Vision-change symptom → Attention; scheduled vision self-check; NASA calls VIIP/SANS its leading spaceflight-related health risk |
| 11 | Spaceflight-Induced Bone Changes | Physiology | Partial | Scheduled bone assessment + resistance-exercise adherence. **No inference of bone loss from other data** |
| 12 | Behavioral Changes & Psychiatric Disorders | Behavioral | **Monitored** | Mood / stress / fatigue check-ins, composite rules, crisis red-flag routing, private support channel |
| 13 | Inadequate Teamwork | Behavioral | Partial | Optional weekly team-climate question (P2) |
| 14 | Inadequate Sleep & Irregular Schedules | Behavioral | **Monitored** | Sleep duration and quality, deficit rules; light exposure from actigraphy (P2, modelled on NASA's ARCHeR wrist device) |
| 15 | Inadequate Systems Operations Support | Behavioral | Partial | The product itself: offline protocols and plain-language decision support |
| 16 | Injury from Dynamic Loads | Behavioral | Out of scope | Landing and launch loads; post-landing symptoms can be logged |
| 17 | Radiation-Induced Cancers | Radiation | Partial | Dose tracking per channel (incl. neutron), cumulative dose vs mission limit, solar particle event shelter protocol. **No cancer-risk prediction** |

---

## 14. Benefits on Earth

The CSA describes ISS research as having two goals: preparing for deep space, and improving life on Earth. ASTRA HEALTH follows the same logic. The same design (personal baselines, explainable alerts, offline-first, store-and-forward to a remote doctor) applies to:
- **Remote and rural communities** with intermittent connectivity and no doctor on site (Arctic stations, ships, mines, field hospitals).
- **Aging and chronic-disease monitoring at home.** The CSA links space research to balance problems in seniors, osteoporosis, cardiovascular disorders and Type 2 diabetes.
- **Mental-wellbeing tracking** in isolated, confined teams (Antarctic crews, submariners).
- **Radiation workers and aircrews**, through per-channel dose tracking. The CSA notes that its radiation technology also serves aircrew protection and cancer therapy.
