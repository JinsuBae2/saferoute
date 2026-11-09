"""Bounded explanation settings; AWS credentials use the standard SDK chain."""

from urllib.parse import urlsplit

from pydantic import Field, field_validator

from backend.contracts.common import Identifier, WireModel


class ExplanationConfig(WireModel):
    controller_url: str = "http://127.0.0.1:8000"
    region: Identifier = "ap-south-1"
    model_id: Identifier = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
    enabled: bool = True
    min_interval_seconds: float = Field(default=5.0, ge=5, le=300)
    timeout_seconds: float = Field(default=5.0, gt=0, le=5)
    ttl_seconds: float = Field(default=15.0, gt=0, le=15)
    max_tokens: int = Field(default=512, ge=64, le=512)

    @field_validator("controller_url")
    @classmethod
    def base_url(cls, value):
        url = urlsplit(value)
        if (url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password
                or url.query or url.fragment or url.path not in {"", "/"}):
            raise ValueError("controller_url must be an HTTP(S) origin without credentials")
        return value.rstrip("/")
