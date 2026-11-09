from collections import deque
from datetime import datetime, timezone
import json
import math
import time
from uuid import uuid4

import httpx

from backend.contracts import parse_contract
from backend.contracts.messages import ObservationEvent


class WorkerError(RuntimeError):
    pass


class Clock:
    def utcnow(self):
        return datetime.now(timezone.utc)

    def monotonic(self):
        return time.monotonic()

    def sleep(self, seconds):
        time.sleep(seconds)


def utc_text(value):
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("observed_at must be timezone-aware")
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class EventBuilder:
    def __init__(self, config, session):
        self.config, self.session = config, session
        self.sequence = 0
        self.history = deque()
        self.last_media_ms = -1

    def _event(self, observed_at, media_ms, kind, hazard=None, score=None, reason=None):
        self.sequence += 1
        return ObservationEvent(
            schema_version=1, run_id=self.session.run_id,
            building_id=self.session.building_id, building_version=self.session.building_version,
            source_id=self.config.source_id, source_type="VIDEO_AI",
            event_id=str(uuid4()), source_sequence=self.sequence, event_kind=kind,
            hazard_type=hazard, confidence=score, observed_at=utc_text(observed_at),
            media_time_ms=media_ms, validity="UNAVAILABLE" if kind == "UNAVAILABLE" else "VALID",
            reason_code=reason,
        ).model_dump(mode="json")

    def observation(self, media_ms, observed_at, detections):
        if type(media_ms) is not int or media_ms < 0 or media_ms <= self.last_media_ms:
            raise WorkerError("INVALID_MEDIA_TIME")
        scores = {}
        for box in detections:
            hazard, score = box["class"], box["confidence"]
            if hazard not in {"FIRE", "SMOKE"} or not math.isfinite(score) or not 0 <= score <= 1:
                raise WorkerError("INVALID_DETECTION")
            if score >= self.config.confidence:
                scores[hazard] = max(scores.get(hazard, 0), score)
        self.last_media_ms = media_ms
        self.history.append((media_ms, scores))
        while self.history[0][0] <= media_ms - self.config.window_ms:
            self.history.popleft()
        alarms = [h for h in ("FIRE", "SMOKE") if h in scores and
                  sum(h in entry for _, entry in self.history) >= self.config.min_detections]
        if not alarms:
            return [self._event(observed_at, media_ms, "OBSERVATION")]
        return [self._event(observed_at, media_ms, "ALARM", h, scores[h]) for h in alarms]

    def unavailable(self, reason, observed_at, media_ms=None):
        return self._event(observed_at, media_ms, "UNAVAILABLE", reason=reason)


def get_contract(client, path, model):
    response = client.get(path)
    response.raise_for_status()
    return parse_contract(model, response.json())


class EventSender:
    def __init__(self, client, config, session, freshness_ms, log, clock):
        self.client, self.config, self.session = client, config, session
        self.freshness_ms, self.log, self.clock = freshness_ms, log, clock

    def send(self, event):
        # Freeze once: ambiguous delivery retries must not create a newer observation.
        payload = json.dumps(event, allow_nan=False, separators=(",", ":")).encode("utf-8")
        observed = datetime.fromisoformat(event["observed_at"].replace("Z", "+00:00"))
        for attempt in range(1, self.config.max_attempts + 1):
            age_ms = (self.clock.utcnow() - observed).total_seconds() * 1000
            if age_ms < 0 or age_ms >= self.freshness_ms:
                raise WorkerError("STALE_OR_FUTURE_OBSERVATION")
            try:
                current = get_contract(self.client, "/api/session", "Session")
                if (current.run_id, current.building_id, current.building_version) != (
                        self.session.run_id, self.session.building_id, self.session.building_version):
                    raise WorkerError("RUN_OR_BUILDING_CHANGED")
                self.log("send_attempt", attempt=attempt, event=event)
                response = self.client.post("/api/events", content=payload,
                                            headers={"Content-Type": "application/json"})
                if response.is_success:
                    receipt = parse_contract("EventReceipt", response.json())
                    if (not receipt.accepted or receipt.event_id != event["event_id"]
                            or receipt.run_id != event["run_id"]):
                        raise WorkerError("RECEIPT_MISMATCH")
                    self.log("send_result", attempt=attempt, event_id=event["event_id"],
                             receipt=receipt.model_dump(mode="json"))
                    return receipt
                self.log("send_rejected", attempt=attempt, event_id=event["event_id"],
                         status_code=response.status_code)
                if response.status_code < 500:
                    raise WorkerError(f"EVENT_REJECTED_{response.status_code}")
            except httpx.TransportError as error:
                self.log("transport_error", attempt=attempt, event_id=event["event_id"],
                         error_type=type(error).__name__)
            if attempt < self.config.max_attempts:
                self.clock.sleep(self.config.retry_delay_ms / 1000)
        raise WorkerError("DELIVERY_FAILED")
