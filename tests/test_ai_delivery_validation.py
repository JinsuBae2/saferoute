import hashlib
import json

import pytest

from tools.validate_ai_delivery import ASSETS, ROOT, check_observation_freshness, main, select_assets


@pytest.mark.parametrize("ages,gaps", [([1000, 0], [2500]), ([1000, 0], [2000]),
                                       ([0, 3000], [500]), ([-1, 0], [500]),
                                       ([0, 0], [-1]), ([0, 0], [])])
def test_freshness_rejects_expiry_or_invalid_measurements(ages, gaps):
    with pytest.raises(ValueError, match="freshness"):
        check_observation_freshness(ages, gaps, 3000)


def test_freshness_uses_each_observations_remaining_lifetime():
    assert check_observation_freshness([1000, 0], [1999], 3000) == 2999
    assert check_observation_freshness([0, 1000, 0], [2500, 500], 3000) == 2500


def test_freshness_rejects_recorded_expiry_before_eof_even_with_short_observation_gaps():
    with pytest.raises(ValueError, match="source expired"):
        check_observation_freshness([0, 0], [500], 3000, source_expirations=1)


def test_default_development_selection_and_explicit_order():
    manifest = json.loads((ROOT / "data/manifests/assets.json").read_text(encoding="utf-8"))
    assert tuple(a["asset_id"] for a in select_assets(manifest, ASSETS)) == ASSETS
    selection = ["dev-joss-smoke", "dev-flameless-candle"]
    assert [a["asset_id"] for a in select_assets(manifest, selection)] == selection


@pytest.mark.parametrize("case", ["empty", "duplicate_selection", "unknown", "evaluation", "duplicate_manifest"])
def test_invalid_selection_is_rejected(case):
    asset = dict(asset_id="dev", split="development")
    manifest, selection = dict(videos=[asset]), ["dev"]
    if case == "empty": selection = []
    elif case == "duplicate_selection": selection *= 2
    elif case == "unknown": selection = ["missing"]
    elif case == "evaluation": asset["split"] = "evaluation"
    elif case == "duplicate_manifest": manifest["videos"].append(dict(asset))
    with pytest.raises(ValueError):
        select_assets(manifest, selection)


def test_selected_video_hash_is_checked_before_controller_or_output_creation(tmp_path, monkeypatch):
    video = tmp_path / "input.bin"
    video.write_bytes(b"wrong bytes")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps(dict(videos=[dict(asset_id="dev", split="development",
                        path=str(video), sha256="a"*64)])), encoding="utf-8")
    def forbidden(*args, **kwargs):
        raise AssertionError("controller must not start for mismatched input")
    monkeypatch.setattr("tools.validate_ai_delivery.uvicorn.Server", forbidden)
    out = tmp_path / "run"
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        main(["--manifest", str(manifest), "--asset-id", "dev", "--output", str(out)])
    assert not out.exists()


@pytest.mark.parametrize("exists", [False, True])
def test_invalid_config_is_rejected_before_starting_controller(tmp_path, monkeypatch, exists):
    video = tmp_path / "input.bin"
    video.write_bytes(b"fixture")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps(dict(videos=[dict(asset_id="dev", split="development",
                        path=str(video), sha256=hashlib.sha256(video.read_bytes()).hexdigest())])), encoding="utf-8")
    config = tmp_path / "config.json"
    if exists:
        config.write_text("{}", encoding="utf-8")
    def forbidden(*args, **kwargs):
        raise AssertionError("controller must not start for invalid config")
    monkeypatch.setattr("tools.validate_ai_delivery.uvicorn.Server", forbidden)
    out = tmp_path / "run"
    with pytest.raises((OSError, ValueError)):
        main(["--manifest", str(manifest), "--asset-id", "dev", "--config", str(config), "--output", str(out)])
    assert not out.exists()
