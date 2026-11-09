"""F11 explanation wire shape, separate from controller state and commands."""

from datetime import datetime
from typing import Literal

from pydantic import model_validator

from .common import Identifier, NonnegativeInt, RunIdentity, Text, UTCString, unique


class Explanation(RunIdentity):
    guidance_version: NonnegativeInt
    status: Literal["PENDING", "READY", "UNAVAILABLE"]
    basis_generated_at: UTCString
    generated_at: UTCString | None
    expires_at: UTCString | None
    summary: Text | None
    fact_refs: list[Identifier]
    model_id: Identifier | None
    prompt_version: Identifier | None
    error_code: Literal[
        "BEDROCK_UNAVAILABLE", "INVALID_RESPONSE", "STALE_BASIS", "EXPLANATION_LOG_ERROR", "DISABLED",
    ] | None

    @model_validator(mode="after")
    def status_fields(self):
        unique(self.fact_refs, "explanation fact reference")
        if self.status == "READY":
            if any(value is None for value in (
                self.generated_at, self.expires_at, self.summary, self.model_id, self.prompt_version,
            )) or not self.fact_refs:
                raise ValueError("READY needs text, facts, model, prompt, and timestamps")
            if not (datetime.fromisoformat(self.basis_generated_at)
                    <= datetime.fromisoformat(self.generated_at)
                    < datetime.fromisoformat(self.expires_at)):
                raise ValueError("READY requires basis <= generation < expiry")
        elif any(value is not None for value in (self.generated_at, self.expires_at, self.summary)) or self.fact_refs:
            raise ValueError("non-READY explanations cannot contain text, facts, or result timestamps")
        if (self.status == "UNAVAILABLE") != (self.error_code is not None):
            raise ValueError("only UNAVAILABLE requires an error code")
        return self
