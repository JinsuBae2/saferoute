"""Optional bounded, disposable child process. The AI loop never waits on HTTP/JPEG."""

import base64
from datetime import timedelta
import math
import multiprocessing
from queue import Empty, Full
import sys

import httpx

from backend.contracts.previews import Preview
from preview_worker.store import MAX_BODY, loopback_origin, utcnow
from .events import utc_text

REASONS = ('EOF', 'VIDEO_OPEN_FAILED', 'DECODE_FAILED', 'INFERENCE_FAILED',
           'DELIVERY_FAILED', 'PREVIEW_FAILED', 'OPERATOR_STOPPED')


def make_update(identity, frame, detections, frame_id, frame_index, media_ms, observed, completed, cv2):
    height, width = frame.shape[:2]
    if height <= 0 or width <= 0 or height * width > 16_000_000:
        raise ValueError('unsupported preview dimensions')
    boxes = []
    for detection in detections:
        raw = detection['xyxy']
        if len(raw) != 4 or any(not math.isfinite(x) for x in raw):
            raise ValueError('invalid preview coordinates')
        x1, y1, x2, y2 = [max(0., min(1., p / size)) for p, size in zip(raw, [width, height, width, height])]
        if x1 < x2 and y1 < y2:
            boxes.append(dict(hazard_type=detection['class'], confidence=detection['confidence'], xyxy=[x1,y1,x2,y2]))
    # Encode the exact analyzed frame, downscaled only, without drawing or cropping.
    scale = min(1., 640 / max(width, height))
    image = cv2.resize(frame, (max(1, round(width*scale)), max(1, round(height*scale)))) if scale < 1 else frame
    ok, encoded = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, 80])
    if not ok or len(encoded) > MAX_BODY // 2:
        raise ValueError('preview encoding failed or too large')
    now = utcnow()
    expires = observed + timedelta(milliseconds=identity['freshness_ms'])
    if now >= expires:
        return dict(preview=status_value(identity, 'STALE'), jpeg_base64=None)
    metadata = dict(frame_id=frame_id, frame_index=frame_index, media_time_ms=media_ms,
                    observed_at=utc_text(observed), inference_completed_at=utc_text(completed),
                    expires_at=utc_text(expires), width=width, height=height, detections=boxes)
    preview = Preview(**identity, generated_at=utc_text(now), status='READY', frame=metadata, error_code=None)
    return dict(preview=preview.model_dump(mode='json'), jpeg_base64=base64.b64encode(encoded).decode('ascii'))


def status_value(identity, status, reason=None):
    return Preview(**identity, generated_at=utc_text(utcnow()), status=status, frame=None,
                   error_code=reason).model_dump(mode='json')


def publish_loop(queue, terminal, url, identity):
    import cv2
    sequence = 0
    with httpx.Client(timeout=0.5, trust_env=False, follow_redirects=False) as client:
        def post(value):
            nonlocal sequence
            sequence += 1
            try:
                response = client.post(url + '/internal/preview', json=dict(sequence=sequence, **value))
                response.raise_for_status()
            except httpx.HTTPError as error:
                print(f'Preview delivery unavailable: {type(error).__name__}', file=sys.stderr)

        while True:
            code = terminal.value
            if code:
                reason = REASONS[code-1]
                post(dict(preview=status_value(identity, 'EOF' if reason == 'EOF' else 'UNAVAILABLE',
                                              None if reason == 'EOF' else reason), jpeg_base64=None))
                return
            try:
                item = queue.get(timeout=0.05)
            except Empty:
                continue
            try:
                value = make_update(identity, *item, cv2)
            except Exception as error:
                print(f'Preview encoding unavailable: {type(error).__name__}', file=sys.stderr)
                value = dict(preview=status_value(identity, 'UNAVAILABLE', 'PREVIEW_FAILED'), jpeg_base64=None)
            if not terminal.value:
                post(value)


class Publisher:
    def __init__(self, url, session, source):
        url = loopback_origin(url)
        identity = dict(schema_version=1, run_id=session.run_id, building_id=session.building_id,
                        building_version=session.building_version, source_id=source.source_id,
                        freshness_ms=source.freshness_ms)
        ctx = multiprocessing.get_context('spawn')
        self.queue = ctx.Queue(maxsize=1)
        self.queue.cancel_join_thread()
        self.terminal = ctx.Value('i', 0)
        self.process = ctx.Process(target=publish_loop, args=(self.queue, self.terminal, url, identity), daemon=True)
        self.dropped = 0
        self.process.start()

    def offer(self, *item):
        # The queue feeder serializes off the AI thread; cap one pending + one encoding frame.
        height, width = item[0].shape[:2]
        if height * width > 16_000_000 or not self.process.is_alive():
            self.dropped += 1
            return
        try:
            self.queue.put_nowait(item)
        except Full:
            self.dropped += 1

    def close(self, reason):
        self.terminal.value = REASONS.index(reason) + 1
        self.process.join(timeout=2)
        if self.process.is_alive():
            self.process.terminate()
            self.process.join(timeout=1)
        self.queue.close()
