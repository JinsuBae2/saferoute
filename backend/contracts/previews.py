"""A06 display-only frame metadata; this does not assert observation validity."""

from datetime import datetime, timedelta
from typing import Annotated, Literal

from pydantic import Field, model_validator

from .common import Identifier, NonnegativeInt, PositiveInt, RunIdentity, UTCString, UUIDString, WireModel

UnitNumber = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


class PreviewDetection(WireModel):
    hazard_type: Literal["FIRE", "SMOKE"]
    confidence: UnitNumber
    xyxy: Annotated[list[UnitNumber], Field(min_length=4, max_length=4)]

    @model_validator(mode="after")
    def nonempty_box(self):
        x1, y1, x2, y2 = self.xyxy
        if x1 >= x2 or y1 >= y2:
            raise ValueError("xyxy must have positive width and height")
        return self


class PreviewFrame(WireModel):
    frame_id: UUIDString
    frame_index: NonnegativeInt
    media_time_ms: NonnegativeInt
    observed_at: UTCString
    inference_completed_at: UTCString
    expires_at: UTCString
    width: PositiveInt
    height: PositiveInt
    detections: list[PreviewDetection]

    @model_validator(mode="after")
    def ordered_times(self):
        if not (datetime.fromisoformat(self.observed_at)
                <= datetime.fromisoformat(self.inference_completed_at)
                < datetime.fromisoformat(self.expires_at)):
            raise ValueError("frame requires observation <= inference completion < expiry")
        return self


class Preview(RunIdentity):
    source_id: Identifier
    generated_at: UTCString
    freshness_ms: PositiveInt
    status: Literal["INITIALIZING", "READY", "STALE", "EOF", "UNAVAILABLE"]
    frame: PreviewFrame | None
    error_code: Literal[
        "VIDEO_OPEN_FAILED", "DECODE_FAILED", "INFERENCE_FAILED", "DELIVERY_FAILED",
        "PREVIEW_FAILED", "OPERATOR_STOPPED",
    ] | None

    @model_validator(mode="after")
    def status_fields(self):
        if (self.status == "READY") != (self.frame is not None):
            raise ValueError("only READY requires a frame; other states must clear it")
        if (self.status == "UNAVAILABLE") != (self.error_code is not None):
            raise ValueError("only UNAVAILABLE requires an error code")
        if self.frame is not None:
            observed = datetime.fromisoformat(self.frame.observed_at)
            completed = datetime.fromisoformat(self.frame.inference_completed_at)
            expires = datetime.fromisoformat(self.frame.expires_at)
            if not completed <= datetime.fromisoformat(self.generated_at) < expires:
                raise ValueError("READY requires completion <= response generation < expiry")
            if expires - observed > timedelta(milliseconds=self.freshness_ms):
                raise ValueError("frame lifetime must not restart at inference or response time")
        return self
