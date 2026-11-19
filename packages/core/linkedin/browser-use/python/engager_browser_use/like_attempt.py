"""A like attempt's own record: the one line it leaves in the log, and the mark
on a refusal raised before its POST (`not_attempted`).

Kept apart from `like_data.py`, which reads what the post's data says of a
reaction and knows nothing of the log or of a refusal's mark.
"""

from __future__ import annotations

import sys
from collections.abc import Iterator
from contextlib import contextmanager

from .protocol import SidecarError


class LikeAttempt:
	"""What one like attempt did, and the one line it leaves in the log: the
	kind of target (post, comment or reply), whether its one POST went out,
	and what was read back — no name, text or id."""

	def __init__(self, kind: str) -> None:
		self.kind = kind
		self.sent = "no"
		self.result = "no answer"

	def failed(self, error: SidecarError) -> None:
		if self.result == "no answer":
			self.result = f"error {error.code}"

	def log(self) -> None:
		print(
			f"[like] {self.kind} sent={self.sent} result={self.result}",
			file=sys.stderr,
			flush=True,
		)


@contextmanager
def pressed_nothing() -> Iterator[None]:
	"""Marks the SidecarError raised inside as one of a like that did not go
	out (`not_attempted`): everything run inside happens before its POST. The
	client reads the mark; a failure after the POST carries none — LinkedIn's
	stated refusal aside, which created nothing — and a like whose outcome is
	unknown is never called not sent."""
	try:
		yield
	except SidecarError as exc:
		exc.not_attempted = True
		raise
