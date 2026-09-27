"""Exponential backoff retry helper (1, 2, 4, 8, 16 ... seconds)."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")
log = logging.getLogger(__name__)

# Tests replace this to avoid real sleeping.
sleep: Callable[[float], None] = time.sleep


class NonRetryableError(Exception):
    """Raise (or wrap) to stop retrying immediately."""


def backoff_delays(max_attempts: int, base: float) -> list[float]:
    return [base * (2**i) for i in range(max(0, max_attempts - 1))]


def retry_call(
    fn: Callable[[], T],
    *,
    max_attempts: int = 5,
    base_delay: float = 1.0,
    retry_on: tuple[type[BaseException], ...] = (Exception,),
    what: str = "operation",
) -> T:
    """Call fn, retrying with exponential backoff on retry_on exceptions."""
    attempts = max(1, max_attempts)
    delays = backoff_delays(attempts, base_delay)
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except NonRetryableError:
            raise
        except retry_on as exc:
            if attempt >= attempts:
                log.warning("%s failed after %d attempts: %s", what, attempt, type(exc).__name__)
                raise
            delay = delays[attempt - 1]
            log.info(
                "%s failed (attempt %d/%d, %s); retrying in %.1fs",
                what, attempt, attempts, type(exc).__name__, delay,
            )
            sleep(delay)
    raise RuntimeError("unreachable")  # pragma: no cover
