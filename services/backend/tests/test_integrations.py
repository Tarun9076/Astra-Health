"""Parsers for the cached real-data fixtures (no network). T-EXT-01, T-EXT-03."""

from datetime import UTC, date, datetime

from astra.integrations import horizons, nasa_donki
from astra.integrations.fixtures import DONKI_SEP_MAY_2024, HORIZONS_MARS_MISSION, load_fixture


def test_donki_may_2024_storm_fixture() -> None:
    events = nasa_donki.parse_sep(load_fixture(DONKI_SEP_MAY_2024))
    assert len(events) == 14
    assert events[0].event_time == datetime(2024, 5, 9, 13, 59, tzinfo=UTC)
    assert nasa_donki.event_day_offsets(events) == [0, 1, 2, 4]


def test_horizons_light_time_fixture() -> None:
    rows = horizons.parse_light_time(load_fixture(HORIZONS_MARS_MISSION))
    by_day = {r.day: r for r in rows}
    assert len(rows) == 121
    assert round(by_day[date(2026, 11, 14)].one_way_minutes, 1) == 11.0
    assert round(by_day[date(2026, 7, 17)].one_way_minutes, 1) == 17.1


def test_fixtures_never_contain_the_api_key() -> None:
    assert "api_key" not in DONKI_SEP_MAY_2024.read_text(encoding="utf-8")
