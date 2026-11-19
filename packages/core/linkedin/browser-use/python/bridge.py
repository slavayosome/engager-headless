#!/usr/bin/env python3
"""NDJSON stdio entrypoint.  Stdout is protocol-only; diagnostics use stderr."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
from pathlib import Path
from typing import Any

from engager_browser_use.backend import BrowserUseBackend
from engager_browser_use.journal import DurableJournal
from engager_browser_use.protocol import SidecarError, error_response, ready_event
from engager_browser_use.service import SidecarService


def emit(value: dict[str, Any]) -> None:
	sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
	sys.stdout.flush()


def parse_args() -> argparse.Namespace:
	parser = argparse.ArgumentParser(description="Engager Browser Use NDJSON sidecar")
	parser.add_argument("--profile-dir", help="dedicated persistent browser profile directory")
	parser.add_argument(
		"--browser-executable",
		help="Engager's own downloaded Chromium; the sidecar runs exactly this one",
	)
	parser.add_argument("--journal-path", help="override the durable write journal path")
	parser.add_argument(
		"--browser-hidden",
		choices=["true", "false"],
		help="hide the headed browser app on macOS (default true)",
	)
	parser.add_argument(
		"--self-check",
		action="store_true",
		help="start Engager's browser on --profile-dir, check it starts and keeps a cookie across a restart, and exit (setup's Browser check)",
	)
	return parser.parse_args()


async def self_check() -> int:
	"""Setup's Browser check (US-OND-05): one JSON object on stdout, exit 0 only
	when the pinned browser started, kept a test cookie across a restart and
	closed (`KEYCHAIN_REFUSED` when the cookie did not survive, US-OND-09).
	Holds no journal and serves no request -- it never takes the lock the
	standing browser's holder owns.

	It leaves with `os._exit`, like the signal path below: Browser Use leaves
	tasks behind that keep asyncio's own teardown open for as long as they
	like (found live: the browser was gone and the process still ran), and a
	check that has its answer must not wait on them."""
	code = 0
	try:
		result = await BrowserUseBackend().self_check()
		emit({"ok": True, **result})
	except SidecarError as exc:
		emit({"ok": False, "code": exc.code, "message": str(exc)})
		code = 1
	sys.stderr.flush()
	os._exit(code)
	return code  # only a test that has replaced `os._exit` gets here


async def run() -> int:
	args = parse_args()
	if args.profile_dir:
		os.environ["ENGAGER_BROWSER_PROFILE_DIR"] = str(Path(args.profile_dir).expanduser().resolve())
	if args.browser_executable:
		os.environ["ENGAGER_BROWSER_EXECUTABLE"] = str(Path(args.browser_executable).expanduser().resolve())
	if args.browser_hidden:
		os.environ["ENGAGER_BROWSER_HIDDEN"] = args.browser_hidden
	if args.self_check:
		return await self_check()
	profile_dir = Path(os.environ.get("ENGAGER_BROWSER_PROFILE_DIR", "~/.engager/browser-profile")).expanduser()
	journal_path = Path(
		args.journal_path
		or os.environ.get("ENGAGER_BROWSER_JOURNAL_PATH", str(profile_dir.parent / "browser-use-journal.json"))
	)

	try:
		journal = DurableJournal(journal_path)
	except SidecarError as exc:
		print(f"sidecar startup failed: {exc}", file=sys.stderr)
		return 1

	service = SidecarService(BrowserUseBackend(), journal)

	# A bare SIGTERM used to orphan Chrome: the supervisor tears down by group
	# signal, which reaches this process directly, and killing the sidecar
	# without closing the browser leaves a Chromium that outlives everything and
	# holds the user-data-dir lock. Close the browser and release the journal
	# first, whatever order the group signal reached us in; `service.close()`
	# tolerates a Chrome the same signal already took. `os._exit` because the
	# main loop is blocked in a stdin thread that no cancellation reaches.
	#
	# ONE close, whichever way the end arrives. EOF and a group signal both
	# reach us on an ordinary shutdown — the node client ends stdin and then
	# reaps — and `backend.shutdown` now WAITS for Chromium to exit, so a second
	# close started beside the first would run a second browser teardown
	# concurrently and spend its whole budget again. A shared future makes the
	# signal path wait out the close already running instead.
	closing: asyncio.Future[None] | None = None

	def _close_once() -> "asyncio.Future[None]":
		nonlocal closing
		if closing is None:
			closing = asyncio.ensure_future(service.close())
		return closing

	async def _terminate() -> None:
		service.stopped = True
		try:
			await _close_once()
		except Exception as exc:  # noqa: BLE001 — exiting regardless
			print(f"sidecar shutdown reported: {exc}", file=sys.stderr, flush=True)
		finally:
			os._exit(0)

	loop = asyncio.get_running_loop()
	for signum in (signal.SIGTERM, signal.SIGINT):
		try:
			loop.add_signal_handler(signum, lambda: loop.create_task(_terminate()))
		except (NotImplementedError, RuntimeError):  # non-POSIX loop — EOF still works
			pass

	emit(ready_event())
	try:
		while not service.stopped:
			line = await asyncio.to_thread(sys.stdin.readline)
			if line == "":
				break
			if not line.strip():
				continue
			try:
				request = json.loads(line)
			except json.JSONDecodeError as exc:
				emit(error_response("unknown", "unknown", SidecarError("INVALID_JSON", str(exc))))
				continue
			emit(await service.handle_request(request))
	finally:
		await _close_once()
	return 0


if __name__ == "__main__":
	raise SystemExit(asyncio.run(run()))
