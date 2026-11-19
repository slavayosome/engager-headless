"""The owner's choice of window for Engager's browser, and what hiding it came to.

Two small files beside the browser profile, like the journal, each with one
writer:

- `browser-window.json` is the owner's choice on Settings › This Mac,
  `{"window": "hidden" | "shown"}`. The dashboard writes it; every launch reads
  it, so a restart and the nightly recycle keep what was chosen while the
  browser was down.
- `browser-window-state.json` is what the last attempt to hide the window came
  to, `{"hideFailed": bool, "at": <epoch ms>}`. Only the browser holder writes
  it; the settings and channel pages read it to say the window could not be
  hidden.

`packages/core/linkedin/browser-use/windowChoice.ts` spells both names again for
the dashboard, and the suite pins the two copies equal.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

CHOICE_FILE = "browser-window.json"
STATE_FILE = "browser-window-state.json"
CHOICES = frozenset({"hidden", "shown"})


def read_choice(directory: Path) -> str | None:
	"""The owner's saved choice, or None where none is saved or it does not read
	as one: the caller's default then decides, never a guess."""
	try:
		value = json.loads((directory / CHOICE_FILE).read_text(encoding="utf-8"))
	except (OSError, ValueError):
		return None
	choice = value.get("window") if isinstance(value, dict) else None
	return choice if choice in CHOICES else None


def record_hide(directory: Path, *, failed: bool) -> None:
	"""Record what the last hide came to, replacing the file whole so a reader
	never sees half of it. Best-effort like the hide itself: a record that
	cannot be written is one stderr line, never a failed operation."""
	path = directory / STATE_FILE
	temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
	try:
		temporary.write_text(
			json.dumps({"hideFailed": failed, "at": int(time.time() * 1000)}) + "\n",
			encoding="utf-8",
		)
		os.replace(temporary, path)
	except OSError as exc:
		print(f"[browser-use] could not record the window state: {exc}", file=sys.stderr, flush=True)
