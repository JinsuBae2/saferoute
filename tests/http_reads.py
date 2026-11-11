"""Functional checks wait for a current read; latency checks use raw HTTP responses."""

import time


def current_read(client, path, **kwargs):
    for attempt in range(3):
        response = client.get(path, **kwargs)
        if response.status_code == 200:
            return response.json()
        assert response.status_code == 503, response.text
        assert response.json()["error"]["code"] == "CONTROLLER_BUSY", response.text
        assert response.headers["Retry-After"] == "1"
        if attempt < 2:
            time.sleep(1)
    raise AssertionError(f"{path} did not recover after bounded busy retries: {response.text}")
