from typing import Annotated, Literal

from pydantic import Field, model_validator

from backend.contracts.common import Identifier, PositiveInt, WireModel


class AIConfig(WireModel):
    building_id: Identifier
    building_version: PositiveInt
    source_id: Identifier
    expected_zone_id: Identifier
    model_path: str
    model_sha256: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    imgsz: Annotated[int, Field(ge=32, le=2048)] = 640
    interval_ms: Annotated[int, Field(ge=50, le=2000)] = 500
    confidence: Annotated[float, Field(gt=0, le=1)] = .25
    cpu_threads: Annotated[int, Field(ge=1, le=4)] = 4
    preprocess: Literal["none", "clahe"] = "none"
    native_input_size: bool = False
    onnx_provider: Literal["cpu", "openvino"] = "cpu"
    window_ms: Annotated[int, Field(ge=50, le=10000)] = 1500
    min_detections: Annotated[int, Field(ge=1, le=100)] = 2
    request_timeout_ms: Annotated[int, Field(ge=100, le=2000)] = 750
    max_attempts: Annotated[int, Field(ge=1, le=3)] = 2
    retry_delay_ms: Annotated[int, Field(ge=0, le=500)] = 100

    @model_validator(mode="after")
    def feasible_window(self):
        if self.window_ms < self.interval_ms * self.min_detections:
            raise ValueError("window_ms must fit min_detections at interval_ms")
        if not self.model_path.strip():
            raise ValueError("model_path is required")
        if self.onnx_provider == "openvino" and not self.model_path.lower().endswith(".onnx"):
            raise ValueError("OpenVINO provider requires an ONNX model file")
        return self

    def validate_mapping(self, building, session):
        expected = (self.building_id, self.building_version)
        if any((x.building_id, x.building_version) != expected for x in (building, session)):
            raise ValueError("building identity does not match config")
        source = next((s for s in building.sources if s.source_id == self.source_id), None)
        if (source is None or source.source_type != "VIDEO_AI"
                or source.zone_id != self.expected_zone_id
                or set(source.allowed_hazard_types) != {"FIRE", "SMOKE"}):
            raise ValueError("VIDEO_AI source/zone/hazards do not match server mapping")
        if self.interval_ms >= source.freshness_ms:
            raise ValueError("sampling interval must be shorter than source freshness")
        return source
