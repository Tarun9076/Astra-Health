# ASTRA HEALTH — Design Documentation

AI-powered astronaut health intelligence & decision-support platform (hackathon prototype).

| # | Document | Read it for |
|---|---|---|
| 1 | [Technical Design Document](01-Technical-Design-Document.md) | Scope, requirements (FR/NFR), architecture decisions (ADRs), stack, AI safety rules, risks, testing, hackathon sources, NASA 17-risk coverage, Earth benefits |
| 2 | [High-Level Design](02-High-Level-Design.md) | System context, Habitat/Ground nodes, components, data-flow sequence diagrams, hazard mapping, UI map |
| 3 | [Low-Level Design](03-Low-Level-Design.md) | Repo layout, DB schema, validation, baseline & rule-engine algorithms, alert state machine, ML, assistant pipeline, sync protocol, API, WebSockets, frontend, simulator, test cases, external data sources (§20) |
| 4 | [Implementation Plan](04-Implementation-Plan.md) | Step-by-step build order (Steps 0–12), milestones, Day-1 commands, team split, cut-lines, demo script |

**The design in one paragraph:** An onboard *Habitat node* (one Python FastAPI backend + SQLite, with a React web app) ingests simulated sensor and check-in data, validates it, compares it with each astronaut's **personal robust baseline**, and runs **versioned deterministic rules** (single and multi-indicator) to raise GREEN/YELLOW/RED alerts with full evidence. ML (Isolation Forest, trend tests) only *corroborates*; an LLM (Claude, with local/template fallbacks and a red-flag bypass) only *explains*, grounded in a cited NASA-sourced knowledge base. Everything works offline; reports travel to an Earth *Ground node* for flight surgeons over a simulated deep-space link with delay and blackouts. Crew health data is simulated (calibrated to published values). The space environment is real: NASA DONKI solar-particle events, the JPL Horizons Earth–Mars light time, and NOAA proton flux.

> ⚠️ Prototype for clinical **decision support** research only. Not a medical device. All thresholds are illustrative; all demo data is simulated.
