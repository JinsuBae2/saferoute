"""Bound HTTP read waits without bypassing expiry or audit durability."""

import asyncio
import logging
import time

from .contracts import ContractError

LOGGER = logging.getLogger(__name__)
READ_WAIT_SECONDS = .25


class SnapshotReader:
    """One pending read per controller, owned by its HTTP application's loop."""

    def __init__(self, controller):
        self.controller = controller
        self.pending = None
        self.reported = False

    def _snapshot(self):
        started, cpu = time.perf_counter(), time.thread_time()
        try:
            return self.controller.snapshot()
        finally:
            elapsed = time.perf_counter() - started
            if elapsed >= READ_WAIT_SECONDS:
                LOGGER.warning("slow_controller_snapshot elapsed_ms=%.1f thread_cpu_ms=%.1f",
                               elapsed * 1000, (time.thread_time() - cpu) * 1000)

    async def read(self):
        deadline = asyncio.get_running_loop().time() + READ_WAIT_SECONDS
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                break
            owns_read = self.pending is None or self.pending.done()
            if owns_read:
                self.pending = asyncio.create_task(asyncio.to_thread(self._snapshot))
                # The last HTTP waiter may time out before an audit failure arrives.
                self.pending.add_done_callback(lambda task: None if task.cancelled() else task.exception())
                self.reported = False
            try:
                result = await asyncio.wait_for(asyncio.shield(self.pending), remaining)
            except TimeoutError:
                break
            except Exception:
                if owns_read: raise
            else:
                if owns_read: return result
            # Wait for earlier work, but never reuse a state captured before this request.
            # A reset or fire may have completed while that result was being delivered.
        if not self.reported:
            LOGGER.warning("controller_read_busy wait_ms=%.0f", READ_WAIT_SECONDS * 1000)
            self.reported = True
        raise ContractError("CONTROLLER_BUSY", "제어 상태 확인이 지연되고 있습니다. 잠시 후 다시 확인합니다") from None

    async def close(self):
        if self.pending is not None:
            # Let an already-started read finish before finalizing the controller log.
            try:
                await self.pending
            except Exception:
                pass
