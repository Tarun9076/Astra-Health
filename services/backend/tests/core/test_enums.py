from astra.core.enums import ALERT_STATUS_RANK, AlertStatus, Severity


def test_severity_is_ordered() -> None:
    assert Severity.NORMAL < Severity.ATTENTION < Severity.URGENT


def test_alert_merge_rank_review_beats_acknowledged() -> None:
    # T-A-03: Habitat says Acknowledged, Ground says InReview → merged state is InReview.
    assert ALERT_STATUS_RANK[AlertStatus.IN_REVIEW] > ALERT_STATUS_RANK[AlertStatus.ACKNOWLEDGED]
    assert ALERT_STATUS_RANK[AlertStatus.RESOLVED] == ALERT_STATUS_RANK[AlertStatus.DISMISSED]


def test_every_status_has_a_rank() -> None:
    assert set(ALERT_STATUS_RANK) == set(AlertStatus)
