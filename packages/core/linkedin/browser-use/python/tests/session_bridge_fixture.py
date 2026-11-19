#!/usr/bin/env python3
"""Fake browser for the real session bridge, service, and durable journal."""
import asyncio
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_critical import Backend
from engager_browser_use.protocol import SidecarError
import bridge

sys.argv = sys.argv[next(i for i, arg in enumerate(sys.argv) if arg.endswith("/bridge.py")):]
profile = Path(sys.argv[sys.argv.index("--profile-dir") + 1])
events = profile.parent / "browser-events"


def record(event):
    with events.open("a") as handle:
        handle.write(f"{event}:{os.getpid()}\n")


class Browser(Backend):
    def __init__(self):
        super().__init__()
        self.prepared = None
        record("opened")

    async def warm_browser(self):
        return {"ok": True}

    async def ensure_session(self, interactive=False):
        return {"ok": True, "account": {"displayName": "Spike User", "externalAccountId": await self.connected_account_id()}}

    async def fetch_own_posts(self, limit):
        return [{"postUrn": "urn:li:activity:1", "authorProfileId": "https://www.linkedin.com/in/example", "authorName": "Example", "authorIsCompany": False, "url": "https://www.linkedin.com/feed/update/urn:li:activity:1/", "contentText": "A deterministic fixture"}][:limit]

    async def prepare_comment(self, value):
        self.prepared = (value["postUrn"], value["text"])
        return {"threadUrn": value["postUrn"], "postThreadUrn": value["postUrn"], "sessionId": "session-1"}

    async def validate_prepared_comment(self, value, prepared):
        if self.prepared != (value["postUrn"], value["text"]) or prepared.get("threadUrn") != value["postUrn"]:
            raise SidecarError("PREPARED_UI_STALE", "target or text changed at click boundary")

    async def commit_prepared_comment(self, value, prepared):
        await self.validate_prepared_comment(value, prepared)
        record("committing")
        while (profile.parent / "slow-commit").exists():
            await asyncio.sleep(0.01)
        result = await super().commit_prepared_comment(value, prepared)
        record("committed")
        return result

    async def shutdown(self):
        await super().shutdown()
        record("closed")


bridge.BrowserUseBackend = Browser
sys.exit(asyncio.run(bridge.run()))
