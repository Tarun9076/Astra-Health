"""ASTRA HEALTH crew-data simulator (Implementation Plan, Step 2).

Run with the backend's virtual environment, from the repo root:

    services/backend/.venv/Scripts/python simulator/simulate.py seed
    services/backend/.venv/Scripts/python simulator/simulate.py preview --indicator resting_hr
    services/backend/.venv/Scripts/python simulator/simulate.py fixtures   (needs ASTRA_NASA_API_KEY)

All generated data is labelled SIMULATED. Calibration sources are listed in scenarios/crew.yaml.
"""

import sys
from collections import Counter
from datetime import date
from pathlib import Path
from typing import Annotated, NoReturn

import httpx
import typer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "backend"))

from astra.config import Settings  # noqa: E402
from astra.integrations import horizons, nasa_donki  # noqa: E402
from astra.integrations.fixtures import (  # noqa: E402
    DONKI_SEP_MAY_2024,
    HORIZONS_MARS_MISSION,
    save_fixture,
)
from astra.seed import default_seed_file, load_seed  # noqa: E402
from astra.simulation.generator import SimReading, generate, generate_environment  # noqa: E402
from astra.simulation.scenario import DEFAULT_SCENARIO, load_scenario  # noqa: E402

app = typer.Typer(help="ASTRA HEALTH crew-data simulator", no_args_is_help=True)

ScenarioOpt = Annotated[Path, typer.Option(help="Scenario YAML")]
SeedOpt = Annotated[int, typer.Option(help="Same seed -> same data")]


def _fail(message: str) -> NoReturn:
    typer.secho(message, fg=typer.colors.RED, err=True)
    raise typer.Exit(1)


def _chunks(items: list[SimReading], size: int) -> list[list[SimReading]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def _sign_in(client: httpx.Client, role: str) -> dict[str, str]:
    """Sign in as the first demo user with this role from seed.local.json / seed.example.json."""
    user = next((u for u in load_seed(default_seed_file()).users if u.role.value == role), None)
    if user is None:
        _fail(f"No {role} user in the seed file")
    response = client.post("/api/auth/login", json={"username": user.username, "password": user.password})
    if response.status_code != 200:
        _fail(
            f"Sign-in as {user.username} failed ({response.status_code}). Did you run: python -m astra.seed ?"
        )
    return {"Authorization": f"Bearer {response.json()['accessToken']}"}


def _close_past_episodes(client: httpx.Client, codes: list[str], start: date, before_day: int) -> int:
    """Act as the flight surgeon: review and resolve alerts whose last trigger is before `before_day`."""
    surgeon = _sign_in(client, "FlightSurgeon")
    closed = 0
    for code in codes:
        alerts = client.get(f"/api/astronauts/{code}/alerts", headers=surgeon).raise_for_status().json()
        for alert in alerts:
            last_day = (date.fromisoformat(alert["lastTriggeredAt"][:10]) - start).days + 1
            if last_day >= before_day:
                continue
            url = f"/api/alerts/{alert['id']}"
            if alert["status"] != "InReview":
                client.post(f"{url}/review", json={}, headers=surgeon).raise_for_status()
            note = (
                f"Past episode (last seen on mission day {last_day}) reviewed and closed "
                "by the flight surgeon (simulated)."
            )
            client.post(f"{url}/resolve", json={"note": note}, headers=surgeon).raise_for_status()
            closed += 1
    return closed


@app.command("seed")
def seed_command(
    api: Annotated[str, typer.Option(help="Habitat backend URL")] = "http://localhost:8000",
    scenario: ScenarioOpt = DEFAULT_SCENARIO,
    random_seed: SeedOpt = 42,
    batch_size: Annotated[int, typer.Option(min=1, max=2000)] = 500,
    dry_run: Annotated[bool, typer.Option(help="Generate and count only; post nothing")] = False,
    close_before_day: Annotated[
        int | None,
        typer.Option(
            help="Close alerts last seen before this mission day, as the flight surgeon. "
            "Default: today's mission day (all past episodes closed, so today's check-in raises alerts "
            "live). 0 = keep everything open."
        ),
    ] = None,
) -> None:
    """Post simulated history up to yesterday, then close past alerts (dates come from the backend)."""
    spec = load_scenario(scenario)
    if dry_run:
        readings = generate(spec, seed=random_seed)
        typer.echo(
            f"Generated {len(readings)} simulated readings: {dict(Counter(r.astronaut for r in readings))}"
        )
        return

    totals: Counter[str] = Counter()
    with httpx.Client(base_url=api, timeout=300) as client:
        try:
            client.get("/health").raise_for_status()
        except httpx.HTTPError as exc:
            _fail(f"Can't reach the backend at {api} ({exc}). Is uvicorn running?")
        admin = _sign_in(client, "Admin")
        crew_rows = client.get("/api/astronauts", headers=admin).raise_for_status().json()
        missing = {c.code for c in spec.crew} - {a["code"] for a in crew_rows}
        if missing:
            _fail(f"Astronauts {sorted(missing)} are not in the database. Run: python -m astra.seed")

        # The database's mission start wins; history stops yesterday so "today" is free for live check-ins.
        start = date.fromisoformat(crew_rows[0]["missionStart"])
        today_day = (date.today() - start).days + 1
        last_day = min(spec.mission.days, today_day - 1)
        if last_day < 1:
            _fail(
                f"Today is mission day {today_day}; the mission hasn't started. "
                "Re-seed with --mission-day-today."
            )
        if today_day - 1 > spec.mission.days:
            typer.secho(
                f"Note: today is mission day {today_day} but the scenario ends on day {spec.mission.days}; "
                "re-seed with `python -m astra.seed --mission-day-today 121` for a continuous demo.",
                fg=typer.colors.YELLOW,
            )
        spec = spec.model_copy(
            update={"mission": spec.mission.model_copy(update={"start": start, "days": last_day})}
        )
        readings = generate(spec, seed=random_seed)
        per_crew = dict(Counter(r.astronaut for r in readings))
        first = spec.mission.date_of(1 - spec.mission.preflight_days)
        typer.echo(
            f"Generated {len(readings)} simulated readings, {first} -> {spec.mission.date_of(last_day)} "
            f"(mission days {1 - spec.mission.preflight_days}..{last_day}; today is day {today_day})"
        )

        # Habitat cabin sensors first, so the crew's history is assessed with the cabin air it had
        cabin = generate_environment(spec, seed=random_seed)
        for i in range(0, len(cabin), 2000):
            response = client.post(
                "/api/environment/readings",
                json={"items": cabin[i : i + 2000]},
                headers=admin | {"X-Backfill": "true"},
            )
            if response.status_code != 201:
                _fail(f"Cabin readings failed: HTTP {response.status_code}: {response.text[:300]}")
        typer.echo(f"  habitat: posted {len(cabin)} cabin readings (temperature, humidity, CO2)")

        for code in sorted(per_crew):
            mine = [r for r in readings if r.astronaut == code]
            alerts = 0
            for chunk in _chunks(mine, batch_size):
                response = client.post(
                    "/api/measurements/batch",
                    json={"astronautId": code, "items": [r.to_api() for r in chunk]},
                    headers=admin | {"X-Backfill": "true"},
                )
                if response.status_code != 201:
                    _fail(f"Batch for {code} failed: HTTP {response.status_code}: {response.text[:300]}")
                body = response.json()
                for key in ("accepted", "questionable", "rejected", "duplicates"):
                    totals[key] += len(body[key])
                alerts += len(body["newAlerts"])
            typer.echo(f"  {code}: posted {len(mine)} readings, {alerts} new alerts")
        typer.echo(f"Done: {dict(totals)}")

        before = today_day if close_before_day is None else close_before_day
        if before > 0:
            closed = _close_past_episodes(client, sorted(per_crew), start, before)
            typer.echo(
                f"Flight surgeon (simulated) closed {closed} past alert(s) last seen before day {before}"
            )


@app.command()
def preview(
    astronaut: str = "AST-001",
    indicator: str = "resting_hr",
    last: Annotated[int, typer.Option(help="Number of most recent readings")] = 14,
    scenario: ScenarioOpt = DEFAULT_SCENARIO,
    random_seed: SeedOpt = 42,
) -> None:
    """Print the last N generated values for one astronaut and indicator (no backend needed)."""
    spec = load_scenario(scenario)
    rows = [
        r
        for r in generate(spec, seed=random_seed)
        if r.astronaut == astronaut and r.indicator == indicator and r.channel in (None, "Total")
    ]
    if not rows:
        _fail(f"No simulated '{indicator}' readings for {astronaut}")
    for r in rows[-last:]:
        day = (r.measured_at.date() - spec.mission.start).days + 1
        typer.echo(f"  day {day:>4}  {r.measured_at:%Y-%m-%d %H:%M}  {r.value:>8} {r.unit}")


@app.command()
def fixtures() -> None:
    """Fetch the real-data fixtures (NASA DONKI May 2024 storm, JPL Horizons light time)."""
    key = Settings().nasa_api_key
    if not key:
        _fail("ASTRA_NASA_API_KEY is empty in services/backend/.env (free key: https://api.nasa.gov/)")
    sep = nasa_donki.fetch_sep(date(2024, 5, 1), date(2024, 5, 31), key)
    save_fixture(DONKI_SEP_MAY_2024, sep)
    typer.echo(f"Saved {len(sep)} DONKI SEP events -> {DONKI_SEP_MAY_2024.name}")
    payload = horizons.fetch_mars_light_time(date(2026, 7, 17), date(2026, 11, 14))
    save_fixture(HORIZONS_MARS_MISSION, payload)
    rows = horizons.parse_light_time(payload)
    latest = rows[-1].one_way_minutes
    typer.echo(
        f"Saved {len(rows)} Horizons rows -> {HORIZONS_MARS_MISSION.name} "
        f"(latest light time {latest:.1f} min)"
    )


if __name__ == "__main__":
    app()
