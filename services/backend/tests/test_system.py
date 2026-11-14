import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from astra.config import Settings
from astra.core.errors import ProtocolError
from astra.main import create_app


def test_status_reports_node_and_disclaimer(client: TestClient) -> None:
    body = client.get("/api/system/status").json()
    assert body["nodeRole"] in {"Habitat", "Ground"}
    assert body["simulatedData"] is True
    assert "Not a diagnosis" in body["disclaimer"]


def test_health_shows_loaded_protocol_counts(client: TestClient) -> None:
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["kbPathExists"] is True
    assert body["protocols"] == {
        "indicators": 22,
        "rules": 17,
        "recommendations": 21,
        "emergencyProtocols": 10,
        "missionProfiles": 1,
    }
    assert body["nasaApi"] in {"enabled", "disabled"}


def test_app_refuses_to_start_with_a_broken_rule(protocols_copy: Path) -> None:
    rule_file = protocols_copy / "rules" / "TH-FEVER.json"
    rule = json.loads(rule_file.read_text(encoding="utf-8"))
    rule["when"]["indicator"] = "body_temperature"  # typo
    rule_file.write_text(json.dumps(rule), encoding="utf-8")

    app = create_app(Settings(protocols_path=protocols_copy))
    expected = "rules/TH-FEVER.json: unknown indicator 'body_temperature'"
    with pytest.raises(ProtocolError, match=expected), TestClient(app):
        pass
