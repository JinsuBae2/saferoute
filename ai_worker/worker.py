import json
import math
import os

from .events import Clock, EventBuilder, EventSender, WorkerError, get_contract, utc_text
from .inference import file_hash
from .video import inspect_video


def run(config, video, client, runs_dir, detector, *, clock=None, cv2_module=None,
        video_probe=inspect_video):
    clock = clock or Clock()
    if cv2_module is None:
        import cv2 as cv2_module
    video_sha256 = file_hash(video)
    session = get_contract(client, "/api/session", "Session")
    building = get_contract(client, "/api/building", "Building")
    source = config.validate_mapping(building, session)
    state = get_contract(client, "/api/state", "StateSnapshot")
    if state.run_id != session.run_id:
        raise WorkerError("RUN_OR_BUILDING_CHANGED")
    owned = next(s for s in state.sources if s.source_id == config.source_id)
    if owned.last_source_sequence is not None:
        raise WorkerError("SOURCE_ALREADY_USED_RESET_REQUIRED")
    directory = runs_dir / session.run_id
    directory.mkdir(parents=True, exist_ok=True)
    # This producer owns only its own file, never the controller's events/manifest.
    with (directory / "ai-predictions.jsonl").open("x", encoding="utf-8") as stream:
        def log(operation, **values):
            stream.write(json.dumps(dict(operation=operation, run_id=session.run_id,
                                        source_type="VIDEO_AI", source_id=config.source_id,
                                        recorded_at=utc_text(clock.utcnow()), **values),
                                    ensure_ascii=False, allow_nan=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())

        builder = EventBuilder(config, session)
        sender = EventSender(client, config, session, source.freshness_ms, log, clock)
        log("start", config=config.model_dump(mode="json"), video_sha256=video_sha256,
            video_name=video.name, mapped_zone_id=source.zone_id,
            model_status="development_candidate_A01_not_final")
        cap = None
        frames, samples, skipped, sent = 0, 0, 0, 0
        previous, next_due, last_media = -1.0, 0, None
        failure_reason, can_notify = "DECODE_FAILED", True
        try:
            inspection = video_probe(video)
            log("video_preflight", **inspection)
            failure_reason = "DECODE_FAILED"
            cap = cv2_module.VideoCapture(str(video))
            if not cap.isOpened():
                raise WorkerError("VIDEO_OPEN_FAILED")
            epoch = clock.monotonic()
            while True:
                failure_reason = "DECODE_FAILED"
                ok, frame = cap.read()
                acquired_at, acquired_mono = clock.utcnow(), clock.monotonic()
                if not ok:
                    if frames != inspection["decoded_frames"]:
                        raise WorkerError(f"DECODE_FRAME_COUNT_MISMATCH: {frames}/{inspection['decoded_frames']}")
                    if not samples:
                        failure_reason = "NO_ANALYZED_FRAMES"
                        raise WorkerError("NO_ANALYZED_FRAMES")
                    can_notify = False
                    sender.send(builder.unavailable("EOF", clock.utcnow(), last_media))
                    sent += 1
                    break
                timestamp = cap.get(cv2_module.CAP_PROP_POS_MSEC)
                if not math.isfinite(timestamp) or timestamp < 0 or timestamp < previous:
                    failure_reason = "INVALID_MEDIA_TIME"
                    raise WorkerError("INVALID_MEDIA_TIME")
                frames += 1
                if timestamp == previous:
                    log("skip_duplicate_time", frame_index=frames-1, media_time_ms=timestamp)
                    continue
                previous = timestamp
                media_ms = round(timestamp)
                if media_ms < next_due:
                    continue
                next_due = (media_ms // config.interval_ms + 1) * config.interval_ms
                lateness_ms = (acquired_mono - epoch) * 1000 - timestamp
                if lateness_ms > config.interval_ms:
                    skipped += 1
                    log("skip_late_frame", frame_index=frames-1, media_time_ms=media_ms,
                        lateness_ms=lateness_ms)
                    continue
                clock.sleep(max(0.0, epoch + timestamp / 1000 - clock.monotonic()))
                failure_reason = "INFERENCE_FAILED"
                detections = detector.predict(frame)
                completed_at = clock.utcnow()
                last_media, samples = media_ms, samples + 1
                failure_reason = "INVALID_DETECTION"
                events = builder.observation(media_ms, acquired_at, detections)
                log("prediction", frame_index=frames-1, media_time_ms=media_ms,
                    observed_at=utc_text(acquired_at), inference_completed_at=utc_text(completed_at),
                    read_to_completion_ms=(clock.monotonic()-acquired_mono)*1000,
                    detections=detections, events=events)
                for event in events:
                    # Do not start a second delivery loop after an ambiguous API failure.
                    can_notify = False
                    sender.send(event)
                    sent += 1
                    can_notify = True
            result = dict(run_id=session.run_id, frames=frames, analyzed_frames=samples,
                          skipped_late_frames=skipped, accepted_events=sent,
                          termination="EOF")
            log("finished", result=result)
            return result
        except (Exception, KeyboardInterrupt) as error:
            reason = "OPERATOR_STOPPED" if isinstance(error, KeyboardInterrupt) else failure_reason
            if not can_notify and not isinstance(error, KeyboardInterrupt):
                reason = str(error) if isinstance(error, WorkerError) else "DELIVERY_FAILED"
            if isinstance(error, WorkerError) and str(error).startswith("VIDEO_PREFLIGHT_UNAVAILABLE:"):
                reason = "VIDEO_PREFLIGHT_UNAVAILABLE"
            log("failed", reason_code=reason, error_type=type(error).__name__, detail=str(error))
            if can_notify:
                try:
                    sender.send(builder.unavailable(reason, clock.utcnow(), last_media))
                except Exception as delivery_error:
                    log("unavailable_delivery_failed", error_type=type(delivery_error).__name__,
                        detail=str(delivery_error))
            raise
        finally:
            if cap is not None:
                cap.release()
