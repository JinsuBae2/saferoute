from pathlib import Path

import pytest

from tools.export_contracts import generated_files, render_type


def test_checked_in_contracts_match_python_models_and_shared_samples():
    root = Path(__file__).resolve().parents[1]
    for path, content in generated_files(root).items():
        assert path.read_text() == content, f"Regenerate {path} with python -m tools.export_contracts"


def test_exporter_fails_instead_of_silently_weakening_unknown_schema():
    with pytest.raises(ValueError):
        render_type({"not": {"type": "string"}})


def test_nullable_and_map_types_are_preserved():
    assert render_type({"anyOf": [{"type": "string"}, {"type": "null"}]}) == "string | null"
    assert render_type({"type": "object", "additionalProperties": {"type": "number"}}) == "Record<string, number>"
    assert render_type({"type": "object", "patternProperties": {"^\\S+$": {"type": "string"}}}) == "Record<string, string>"
    assert render_type({"type": "integer", "minimum": 1, "maximum": 1}) == "1"
