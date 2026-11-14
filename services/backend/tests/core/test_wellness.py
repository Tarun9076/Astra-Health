from astra.core.wellness import ActiveAlert, Reading, wellness_index, z_penalty


def _r(indicator: str, z: float | None, worse: str = "both", value: float = 0.0) -> Reading:
    return Reading(indicator, value, z, worse)  # type: ignore[arg-type]


ALL_NORMAL = {
    i: _r(i, 0.2)
    for i in ("resting_hr", "bp_sys", "bp_dia", "sleep_hours", "sleep_quality", "mood", "stress", "fatigue",
              "activity_min", "glucose", "radiation_dose")
}  # fmt: skip


def test_everything_within_normal_scores_100() -> None:
    result = wellness_index(ALL_NORMAL)
    assert result.overall == 100 and result.cap_reason is None
    assert result.indicators_seen == 11 and result.indicators_total == 15


def test_penalty_only_in_the_unhealthy_direction() -> None:
    assert z_penalty(3.0, "high") == 30.0
    assert z_penalty(-3.0, "high") == 0.0  # e.g. stress well below normal is fine
    assert z_penalty(-3.0, "low") == 30.0
    assert z_penalty(9.0, "both") == 40.0  # capped
    assert z_penalty(0.9, "both") == 0.0  # within 1σ: no penalty


def test_fatigue_story_lowers_sleep_heart_and_behaviour() -> None:
    readings = dict(ALL_NORMAL) | {
        "resting_hr": _r("resting_hr", 9.0),
        "sleep_hours": _r("sleep_hours", -3.3, "low"),
        "fatigue": _r("fatigue", 3.4, "high"),
        "stress": _r("stress", 3.4, "high"),
    }
    calm = wellness_index(readings, sleep_3d_mean=4.4)
    domains = {d.domain: d for d in calm.domains}
    assert domains["Sleep"].score == 100 - 34.5 - 20
    assert domains["Cardiovascular"].score == 60
    assert calm.overall is not None and 60 < calm.overall < 85

    alerts = [
        ActiveAlert(
            "Attention", "Fatigue pattern", frozenset({"sleep_hours", "resting_hr", "fatigue", "mood"})
        )
    ]
    alerted = wellness_index(readings, sleep_3d_mean=4.4, alerts=alerts)
    assert alerted.overall is not None and alerted.overall <= 75 and alerted.overall < calm.overall
    assert "capped at 75" in (alerted.cap_reason or "")
    assert any(
        "active alert" in p.reason for p in {d.domain: d for d in alerted.domains}["Behavioral"].penalties
    )


def test_urgent_alert_caps_at_40() -> None:
    alerts = [ActiveAlert("Urgent", "Solar particle event", frozenset({"radiation_dose"}))]
    assert wellness_index(ALL_NORMAL, alerts=alerts).overall == 40


def test_radiation_spike_and_missing_domains_renormalise() -> None:
    only_rad = {"radiation_dose": Reading("radiation_dose", 19.2, None, "high", ratio=30.0)}
    result = wellness_index(only_rad)
    assert result.overall == 60  # only the Environment domain has data: 100 − 40
    assert [d.domain for d in result.domains if d.score is None] == [
        "Cardiovascular", "Sleep", "Behavioral", "Activity", "Metabolic"
    ]  # fmt: skip
    assert wellness_index({}).overall is None
