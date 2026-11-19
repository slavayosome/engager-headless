"""Crash-durable write journal for the sidecar's exactly-once boundary."""

from __future__ import annotations

import json
import os
import threading
import time
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable

from .protocol import SidecarError

JOURNAL_VERSION = 2
# A version-1 journal belongs to a sidecar that prepared an attempt in one
# request and pressed it in another, and journaled it between. Nothing was sent
# under an entry that never reached CLICKING.
PREVIOUS_JOURNAL_VERSION = 1
WRITE_STATES = {
	"CLICKING",
	"CONFIRMED",
	"UNCERTAIN",
	"RESOLVED_NOT_POSTED",
	# LinkedIn refused it in words after the press — an invitation's weekly
	# limit, say. Settled: nothing under the operation is pressed again.
	"BLOCKED",
}


class DurableJournal:
	"""A single-process JSON journal with atomic replace and an exclusive lock.

	The sidecar is intentionally single-account and single-writer.  Holding the
	lock for the process lifetime prevents two local sidecars from driving the
	same durable posting state concurrently.
	"""

	def __init__(self, path: str | Path):
		self.path = Path(path).expanduser().resolve()
		self.path.parent.mkdir(parents=True, exist_ok=True)
		self._mutex = threading.RLock()
		self._lock_handle = self.path.with_suffix(self.path.suffix + ".lock").open("a+", encoding="utf-8")
		os.chmod(self._lock_handle.name, 0o600)
		try:
			import fcntl

			fcntl.flock(self._lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
		except BlockingIOError as exc:
			self._lock_handle.close()
			raise SidecarError("JOURNAL_LOCKED", f"journal is already in use: {self.path}") from exc
		except ImportError:
			# The supported spike host is macOS.  Atomic replace still protects the
			# file on platforms without fcntl, but cross-process exclusion is absent.
			pass

		self._data = self._read()
		self._prune_terminal()

	def _prune_terminal(self) -> None:
		cutoff = int(time.time() * 1000) - 30 * 24 * 60 * 60 * 1000
		terminal = {"CONFIRMED", "RESOLVED_NOT_POSTED", "BLOCKED"}
		writes = self._data["writes"]
		old = [key for key, entry in writes.items()
			if entry.get("state") in terminal and isinstance(entry.get("updatedAt"), (int, float))
			and entry["updatedAt"] < cutoff]
		if old:
			for key in old:
				del writes[key]
			self._persist()

	def _read(self) -> dict[str, Any]:
		if not self.path.exists():
			return {"version": JOURNAL_VERSION, "writes": {}}
		os.chmod(self.path, 0o600)
		try:
			data = json.loads(self.path.read_text(encoding="utf-8"))
		except (OSError, json.JSONDecodeError) as exc:
			raise SidecarError("JOURNAL_CORRUPT", f"could not read journal: {exc}") from exc
		upgraded = False
		if data.get("version") == PREVIOUS_JOURNAL_VERSION and isinstance(data.get("writes"), dict):
			# Settled once, on upgrade: the entries this sidecar has no state for
			# are the attempts the older one prepared and never pressed.
			data["writes"] = {
				key: entry
				for key, entry in data["writes"].items()
				if not isinstance(entry, dict) or entry.get("state") != "PREPARED"
			}
			data["version"] = JOURNAL_VERSION
			upgraded = True
		if data.get("version") != JOURNAL_VERSION or not isinstance(data.get("writes"), dict):
			raise SidecarError("JOURNAL_CORRUPT", "unsupported or malformed journal")
		for operation_id, entry in data["writes"].items():
			if not isinstance(operation_id, str) or not isinstance(entry, dict) or entry.get("state") not in WRITE_STATES:
				raise SidecarError("JOURNAL_CORRUPT", "journal contains an invalid write entry")
		if upgraded:
			self._data = data
			self._persist()
		return data

	def _persist(self) -> None:
		tmp = self.path.with_name(f".{self.path.name}.tmp-{os.getpid()}")
		payload = json.dumps(self._data, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
		try:
			with tmp.open("w", encoding="utf-8") as handle:
				os.chmod(tmp, 0o600)
				handle.write(payload)
				handle.flush()
				os.fsync(handle.fileno())
			os.replace(tmp, self.path)
			directory_fd = os.open(self.path.parent, os.O_RDONLY)
			try:
				os.fsync(directory_fd)
			finally:
				os.close(directory_fd)
		finally:
			if tmp.exists():
				tmp.unlink()

	def get(self, operation_id: str) -> dict[str, Any] | None:
		with self._mutex:
			entry = self._data["writes"].get(operation_id)
			return deepcopy(entry) if entry is not None else None

	def previous_attempts(self, base: str, version: int) -> list[tuple[str, dict[str, Any]]]:
		with self._mutex:
			result = []
			for key, entry in self._data["writes"].items():
				if key == base:
					attempt = 0
				elif key.startswith(base + ":v") and key[len(base) + 2:].isdigit():
					attempt = int(key[len(base) + 2:])
				else:
					continue
				if attempt < version:
					result.append((attempt, key, deepcopy(entry)))
			return [(key, entry) for _, key, entry in sorted(result, reverse=True)]

	def put(self, operation_id: str, entry: dict[str, Any]) -> dict[str, Any]:
		if entry.get("state") not in WRITE_STATES:
			raise ValueError(f"invalid journal state: {entry.get('state')}")
		with self._mutex:
			self._data["writes"][operation_id] = deepcopy(entry)
			self._persist()
			return deepcopy(entry)

	def mutate(self, operation_id: str, change: Callable[[dict[str, Any]], dict[str, Any]]) -> dict[str, Any]:
		with self._mutex:
			current = self._data["writes"].get(operation_id)
			if current is None:
				raise SidecarError("WRITE_NOT_JOURNALED", f"operation {operation_id} has no journal entry")
			updated = change(deepcopy(current))
			if updated.get("state") not in WRITE_STATES:
				raise ValueError(f"invalid journal state: {updated.get('state')}")
			self._data["writes"][operation_id] = deepcopy(updated)
			self._persist()
			return deepcopy(updated)

	def close(self) -> None:
		if self._lock_handle.closed:
			return
		try:
			import fcntl

			fcntl.flock(self._lock_handle.fileno(), fcntl.LOCK_UN)
		except ImportError:
			pass
		finally:
			self._lock_handle.close()

	def __enter__(self) -> "DurableJournal":
		return self

	def __exit__(self, *_args: object) -> None:
		self.close()
