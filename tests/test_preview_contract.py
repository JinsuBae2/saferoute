"""Synthetic DTO checks, not evidence of video delivery or AI accuracy."""

from copy import deepcopy
import json
from pathlib import Path

import pytest

from backend.contracts import ContractError, parse_contract

SAMPLES = json.loads((Path(__file__).resolve().parents[1] / 'data/contracts/valid.json').read_text(encoding='utf-8'))


def preview():
    return deepcopy(SAMPLES['preview_ready']['payload'])


@pytest.mark.parametrize('value', [float('nan'), float('inf'), True, '0.5', -.01, 1.01])
@pytest.mark.parametrize('field', ['confidence', 'xyxy'])
def test_preview_rejects_nonfinite_coerced_or_out_of_bounds_numbers(field, value):
    payload = preview()
    box = payload['frame']['detections'][0]
    if field == 'xyxy':
        box[field][0] = value
    else:
        box[field] = value
    with pytest.raises(ContractError):
        parse_contract('Preview', payload)


@pytest.mark.parametrize('field', ['frame', 'error_code', 'generated_at', 'freshness_ms'])
def test_nullable_and_lifetime_fields_are_required(field):
    payload = preview()
    del payload[field]
    with pytest.raises(ContractError):
        parse_contract('Preview', payload)


def test_exact_image_edges_and_no_detections_are_valid():
    payload = preview()
    payload['frame']['detections'][0]['xyxy'] = [0, 0, 1, 1]
    assert parse_contract('Preview', payload).frame.detections[0].xyxy == [0., 0., 1., 1.]
    payload['frame']['detections'] = []
    assert parse_contract('Preview', payload).frame.detections == []


def test_time_checks_compare_instants_not_utc_text_format():
    payload = preview()
    payload['frame']['inference_completed_at'] = '2026-11-10T01:00:00.2Z'
    assert parse_contract('Preview', payload).status == 'READY'
    payload['generated_at'] = '2026-11-10T01:00:03Z'
    with pytest.raises(ContractError):
        parse_contract('Preview', payload)


def test_polling_cannot_renew_frame_lifetime():
    payload = preview()
    payload['generated_at'] = '2026-11-10T01:00:02.999Z'
    assert parse_contract('Preview', payload).frame.expires_at == '2026-11-10T01:00:03.000Z'
    payload['frame']['expires_at'] = '2026-11-10T01:00:03.001Z'
    with pytest.raises(ContractError):
        parse_contract('Preview', payload)


def test_lifetime_boundary_uses_exact_timedelta_arithmetic():
    payload = preview()
    payload['freshness_ms'] = 4001
    payload['frame']['expires_at'] = '2026-11-10T01:00:04.001Z'
    assert parse_contract('Preview', payload).status == 'READY'
    payload['frame']['expires_at'] = '2026-11-10T01:00:04.001001Z'
    with pytest.raises(ContractError):
        parse_contract('Preview', payload)
