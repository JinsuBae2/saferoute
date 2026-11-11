"""Distinguish a bounded controller read from permanent HTTP failures."""

import httpx


class ControllerBusy(httpx.HTTPStatusError):
    pass


def raise_for_controller_status(response):
    if response.status_code == 503:
        try:
            body = response.json()
        except ValueError:
            body = None
        if isinstance(body, dict) and isinstance(body.get("error"), dict) and body["error"].get("code") == "CONTROLLER_BUSY":
            raise ControllerBusy("controller read is temporarily busy", request=response.request, response=response)
    response.raise_for_status()
