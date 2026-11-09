"""Single-flight model requests with fresh-state, deadline and log gates."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import time
from uuid import uuid4

from backend.contracts.explanations import Explanation
from .bedrock import PROMPT_VERSION, parse_response
from .facts import extract_basis


def utc_text(value):
    return value.isoformat().replace("+00:00", "Z")


def identity(basis):
    return tuple(basis[key] for key in ("run_id", "building_id", "building_version", "guidance_version"))


class Service:
    """tick() is serialized by the API's asyncio lock; provider has one thread.

    A timed-out SDK call stays in flight until it actually exits. This avoids
    cancellation spawning overlapping billable requests or an unbounded queue.
    """
    def __init__(self, config, provider, journal, *, utcnow=None, monotonic=None):
        self.config, self.provider, self.journal = config, provider, journal
        self.utcnow = utcnow or (lambda: datetime.now(timezone.utc))
        self.monotonic = monotonic or time.monotonic
        self.executor = ThreadPoolExecutor(max_workers=1)
        self.flight = None
        self.result = None
        self.last_start = float("-inf")
        self.epoch = 0
        self.log_failed = False

    def disconnected(self):
        self.epoch += 1
        self.result = None

    def _call(self, basis):
        try:
            response, error = self.provider(basis), None
        except Exception as exc:
            # Do not copy SDK messages, credentials, or provider response bodies to logs.
            details = getattr(exc, "response", {})
            code = details.get("Error", {}).get("Code") if isinstance(details, dict) else None
            response, error = None, code if code in {"AccessDeniedException", "ThrottlingException", "ModelTimeoutException"} else type(exc).__name__
        return response, error, self.utcnow(), self.monotonic()

    def _record(self, flight, outcome, *, response=None, error=None, finished=None, provider_error=None):
        record = {"request_id": flight["id"], "basis": flight["basis"],
                  "model_id": self.config.model_id, "prompt_version": PROMPT_VERSION,
                  "requested_at": utc_text(flight["requested"]),
                  "responded_at": utc_text(finished) if finished else None,
                  "recorded_at": utc_text(self.utcnow()), "outcome": outcome, "error": error,
                  "provider_error": provider_error,
                  "usage": (response or {}).get("usage"),
                  "metrics": (response or {}).get("metrics")}
        if outcome == "accepted":
            record["explanation"] = self.result.model_dump(mode="json")
        try:
            self.journal.write(record)
        except (OSError, ValueError, TypeError):
            self.log_failed = True
            self.result = None

    def _empty(self, basis, error=None):
        return Explanation(**{k: v for k, v in basis.items() if k != "facts"},
                           status="UNAVAILABLE" if error else "PENDING", generated_at=None,
                           expires_at=None, summary=None, fact_refs=[], model_id=self.config.model_id,
                           prompt_version=PROMPT_VERSION, error_code=error)

    def tick(self, state):
        basis = extract_basis(state)
        now, mono = self.utcnow(), self.monotonic()
        basis_time = datetime.fromisoformat(basis["basis_generated_at"])
        error = None
        if self.result and (identity(self.result.model_dump()) != identity(basis)
                            or now >= datetime.fromisoformat(self.result.expires_at)):
            self.result = None
        flight = self.flight
        if flight and flight["future"].done():
            response, failure, finished, finished_mono = flight["future"].result()
            expiry = datetime.fromisoformat(flight["basis"]["basis_generated_at"]) + timedelta(seconds=self.config.ttl_seconds)
            if flight["timed_out"] or finished_mono - flight["started"] >= self.config.timeout_seconds:
                error = "BEDROCK_UNAVAILABLE"
            elif (flight["epoch"] != self.epoch or identity(flight["basis"]) != identity(basis)
                  or now >= expiry or finished < flight["requested"] or finished > now):
                error = "STALE_BASIS"
            elif failure:
                error = "BEDROCK_UNAVAILABLE"
            else:
                try:
                    text = parse_response(response, flight["basis"])
                    self.result = Explanation(**{k: v for k, v in flight["basis"].items() if k != "facts"},
                        status="READY", generated_at=utc_text(finished), expires_at=utc_text(expiry),
                        summary=text.summary, fact_refs=text.fact_refs, model_id=self.config.model_id,
                        prompt_version=PROMPT_VERSION, error_code=None)
                except (ValueError, TypeError, KeyError, AttributeError):
                    error = "INVALID_RESPONSE"
            self._record(flight, "discarded" if error else "accepted", response=response,
                         error=error, finished=finished, provider_error=failure)
            self.flight = None
        elif flight and mono - flight["started"] >= self.config.timeout_seconds:
            error = "BEDROCK_UNAVAILABLE"
            if not flight["timed_out"]:
                self._record(flight, "timeout", error=error)
                flight["timed_out"] = True

        if self.log_failed:
            return self._empty(basis, "EXPLANATION_LOG_ERROR")
        if not self.config.enabled:
            return self._empty(basis, "DISABLED")
        now = self.utcnow()
        if self.result and now >= datetime.fromisoformat(self.result.expires_at):
            self.result = None
            error = "STALE_BASIS"
        if not 0 <= (now - basis_time).total_seconds() < self.config.ttl_seconds:
            self.result = None
            return self._empty(basis, "STALE_BASIS")
        if self.result:
            return self.result
        if error:
            # Preserve a failure through the minimum call interval, not just one poll.
            self.last_error = (identity(basis), error)
        if self.flight is None and mono - self.last_start >= self.config.min_interval_seconds and not error:
            flight = {"id": str(uuid4()), "basis": basis, "requested": now, "started": mono,
                      "epoch": self.epoch, "timed_out": False}
            self._record(flight, "requested")
            if self.log_failed:
                return self._empty(basis, "EXPLANATION_LOG_ERROR")
            self.last_start = mono
            self.last_error = None
            flight["future"] = self.executor.submit(self._call, basis)
            self.flight = flight
        last_error = getattr(self, "last_error", None)
        return self._empty(basis, last_error[1] if last_error and last_error[0] == identity(basis) else error)

    def close(self):
        self.executor.shutdown(wait=True)
        if self.flight:
            response, failure, finished, _ = self.flight["future"].result()
            self._record(self.flight, "discarded", response=response, error=failure or "SHUTDOWN", finished=finished)
        self.journal.close()
