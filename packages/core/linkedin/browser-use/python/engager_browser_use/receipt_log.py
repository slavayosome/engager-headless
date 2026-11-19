"""A profile receipt's own record: the one line it leaves in the log.

Kept apart from `backend.py`, as `like_attempt.py` is for a like. An Accept, an
invitation and a withdrawal are each answered by reads of the member's profile
(`BrowserUseBackend._reread_relationship`); what they came to is written here.
"""

from __future__ import annotations

import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from .protocol import SidecarError


class ReceiptLog:
	"""What one receipt did, and the one line it leaves in the log: the write
	(accept, invite or withdraw), how many reads of the member's profile it
	made, how long after the press it answered, and what the read-back came to
	— no name, text or id. The read-back is not the journal's state: an Accept
	whose request still shows pending is read back `still_pending` and settles
	UNCERTAIN."""

	def __init__(self, kind: str, pressed_at: float) -> None:
		self.kind = kind
		self.pressed_at = pressed_at
		self.reads = 0
		self.read_back = "no answer"

	def read(self) -> None:
		"""A read of the member's profile begun, whether or not it answers."""
		self.reads += 1

	def answered(self, outcome: dict[str, Any]) -> dict[str, Any]:
		"""Note the outcome the receipt returns — its state, and the reason it
		gives where it settled nothing — and hand it back."""
		reason = outcome.get("error")
		self.read_back = f"{outcome['state']} ({reason})" if reason else str(outcome["state"])
		return outcome

	def log(self) -> None:
		after = int(time.monotonic() - self.pressed_at)
		print(
			f"[{self.kind}] reads={self.reads} after={after}s read_back={self.read_back}",
			file=sys.stderr,
			flush=True,
		)


@contextmanager
def receipt_log(kind: str, pressed_at: float) -> Iterator[ReceiptLog]:
	"""Leave the receipt's line in the log however it ends: an error it raises
	is the read-back, as `error <code>`. `pressed_at` is the monotonic time of
	the press the receipt answers."""
	receipt = ReceiptLog(kind, pressed_at)
	try:
		yield receipt
	except SidecarError as exc:
		receipt.read_back = f"error {exc.code}"
		raise
	finally:
		receipt.log()
