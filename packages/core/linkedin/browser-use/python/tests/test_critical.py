import json
import asyncio
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from engager_browser_use.backend import BrowserUseBackend, SidecarError
from engager_browser_use.chromium import Chromium
from engager_browser_use.journal import DurableJournal
from engager_browser_use.service import SidecarService
from engager_browser_use.voyager import VoyagerUnavailable


class CriticalChromiumTests(unittest.IsolatedAsyncioTestCase):
	async def test_post_run_observation_leaves_closed_browser_and_tabs_closed(self):
		backend = BrowserUseBackend.__new__(BrowserUseBackend)
		backend._browser = backend._page = None
		self.assertEqual((await backend.observe_session())["reason"], "browser_closed")
		backend._browser, backend._page = object(), AsyncMock()
		backend._page.get_url.side_effect = RuntimeError("closed tab")
		self.assertEqual((await backend.observe_session())["reason"], "browser_closed")

	async def test_temporary_identity_tab_preserves_the_selected_tab_and_closes_on_failure(self):
		backend = BrowserUseBackend.__new__(BrowserUseBackend)
		backend._browser, backend._assert_ready, backend._block_media_on = AsyncMock(), AsyncMock(), AsyncMock()
		backend._voyager_get = AsyncMock(side_effect=VoyagerUnavailable("no identity"))
		backend._own_from_profile_data = AsyncMock(side_effect=RuntimeError("tab closed"))
		with self.assertRaisesRegex(RuntimeError, "tab closed"):
			await backend.connected_account_id(preserve_page=True)
		backend._browser.new_page.assert_awaited_once_with(background=True)
		backend._browser.close_page.assert_awaited_once_with(backend._browser.new_page.return_value)

	async def test_guard_rechecks_url_and_sessions_are_shared(self):
		async def attach(**_kwargs):
			await asyncio.sleep(0)
			return {"sessionId": "one"}
		client = MagicMock()
		client.send.Target, client.send.Page = AsyncMock(), AsyncMock()
		client.send.Target.attachToTarget.side_effect = attach
		browser = Chromium(client, guard=True)
		a, b = await asyncio.gather(browser.session_for("tab"), browser.session_for("tab"))
		self.assertEqual(a.session_id, b.session_id)
		client.send.Target.attachToTarget.assert_awaited_once()
		for url, signing_in, sent in (("https://www.linkedin.com/feed/", False, 0), ("https://accounts.google.com/signin", True, 0), ("https://accounts.google.com.evil.example/", True, 1), ("https://accounts.google.com/signin", False, 2)):
			client.send.Target.getTargetInfo.return_value = {"targetInfo": {"url": url}}
			browser.owner_signing_in(signing_in)
			await browser._send_back("tab")
			self.assertEqual(client.send.Page.navigate.await_count, sent, url)

	async def test_launch_failure_stops_process(self):
		process = MagicMock(returncode=None, wait=AsyncMock(), pid=42)
		probe = MagicMock()
		probe.__enter__.return_value.getsockname.return_value = ("127.0.0.1", 1234)
		with patch("socket.socket", return_value=probe), \
			patch("asyncio.create_subprocess_exec", AsyncMock(return_value=process)), \
			patch.object(Chromium, "_await_endpoint", AsyncMock(return_value="ws://example")), \
			patch.object(Chromium, "_connect", AsyncMock(return_value=MagicMock())), \
			patch.object(Chromium, "_start", AsyncMock(side_effect=RuntimeError("failed"))), \
			patch.object(Chromium, "detach", AsyncMock()):
			with self.assertRaisesRegex(RuntimeError, "failed"):
				await Chromium.launch(Path("chromium"), [])
		process.wait.assert_awaited_once()


class Backend:
	def __init__(self, journal):
		self.presses, self.journal, self.state_at_press, self.signing_in = 0, journal, None, MagicMock(return_value=False)
		self.rehide_if_needed = self.validate_prepared_comment = self.shutdown = AsyncMock()
		self.reconcile_posted = AsyncMock(return_value=None)
		self.connected_account_id = AsyncMock(return_value="https://www.linkedin.com/in/spike-user")

	async def prepare_comment(self, value):
		return {"threadUrn": value["postUrn"]}

	async def commit_prepared_comment(self, *_args):
		self.presses += 1
		self.state_at_press = (self.journal.get("op-1") or {}).get("state")
		return "urn:li:comment:(urn:li:activity:1,2)"


class CriticalJournalTests(unittest.IsolatedAsyncioTestCase):
	async def asyncSetUp(self):
		self.tmp = tempfile.TemporaryDirectory()
		self.now = int(time.time() * 1000)
		self.open_service()
		self.value = {"kind": "comment", "organizationId": "00000000-0000-4000-8000-000000000001",
			"channelId": 3, "expectedAccountProfileId": "spike-user", "postUrn": "urn:li:activity:1",
			"text": "A careful comment", "marker": "op-1"}

	async def asyncTearDown(self):
		await self.service.close()
		self.tmp.cleanup()

	async def call(self, op, **params):
		return await self.service.handle_request({"v": 1, "id": "fixture", "op": op, "params": params})

	async def write(self, value=None):
		return await self.call("write", operationId="op-1", input=value or self.value)

	async def test_a_write_is_journaled_clicking_before_its_one_press_and_no_later_ask_presses_again(self):
		self.journal._persist = MagicMock(wraps=self.journal._persist)
		self.assertEqual((await self.write())["result"]["state"], "committed")
		self.assertEqual((self.backend.state_at_press, self.journal._persist.call_count, self.backend.presses), ("CLICKING", 2, 1))
		self.assertEqual((await self.write())["result"]["state"], "already_committed")
		self.assertEqual((await self.write({**self.value, "text": "different"}))["error"]["code"], "OPERATION_CONFLICT")
		await self.reopen()
		self.assertEqual((await self.write())["result"]["state"], "already_committed")
		for state in ("CLICKING", "UNCERTAIN"):
			self.journal.mutate("op-1", lambda entry: {**entry, "state": state})
			await self.reopen()
			self.assertEqual((await self.write())["error"]["code"], "WRITE_OUTCOME_UNCERTAIN")
			self.assertEqual(self.backend.presses, 0)

	async def reopen(self):
		await self.service.close()
		self.open_service()

	def open_service(self):
		self.journal = DurableJournal(Path(self.tmp.name) / "journal.json")
		self.backend = Backend(self.journal)
		self.service = SidecarService(self.backend, self.journal, clock_ms=lambda: self.now)

	async def test_restart_prunes_only_old_terminal_entries(self):
		old = int(time.time() * 1000) - 31 * 24 * 60 * 60 * 1000
		for state in ("CONFIRMED", "RESOLVED_NOT_POSTED", "BLOCKED", "CLICKING", "UNCERTAIN"):
			self.journal.put(state, {"state": state, "updatedAt": old})
		self.journal.put("recent", {"state": "CONFIRMED", "updatedAt": int(time.time() * 1000)})
		await self.reopen()
		for state in ("CONFIRMED", "RESOLVED_NOT_POSTED", "BLOCKED"):
			self.assertIsNone(self.journal.get(state))
		for state in ("CLICKING", "UNCERTAIN", "recent"):
			self.assertIsNotNone(self.journal.get(state))

	async def test_an_older_journal_keeps_its_presses_and_drops_what_never_reached_one(self):
		await self.service.close()
		path = Path(self.tmp.name) / "older.json"
		clicking = {"state": "CLICKING", "updatedAt": self.now}
		path.write_text(json.dumps({"version": 1, "writes": {"pressed": clicking, "unpressed": {"state": "PREPARED"}}}))
		journal = DurableJournal(path)
		try:
			self.assertEqual(journal.get("pressed"), clicking)
			self.assertIsNone(journal.get("unpressed"))
		finally:
			journal.close()
		self.assertEqual(json.loads(path.read_text())["version"], 2)


class CriticalOwnPostsTests(unittest.IsolatedAsyncioTestCase):
	async def test_own_posts_keep_only_the_owners_and_page_on_to_the_limit(self):
		rows = lambda *r: [{"postUrn": f"urn:li:activity:{n}", "authorProfileId": who, "authorUrn": urn, "authorIsCompany": co, "isReshare": rs} for n, who, co, rs, urn in r]
		backend = BrowserUseBackend.__new__(BrowserUseBackend)
		backend._own_profile_url, backend._goto, backend._own_member_id, backend._own_profile_urn, backend._voyager_member_profile = "https://www.linkedin.com/in/Me", AsyncMock(), "7", None, AsyncMock(return_value=({}, "urn:li:fsd_profile:x"))
		backend._voyager_get = AsyncMock(side_effect=[{"data": {"metadata": {"paginationToken": "t"}}}, {}])
		with patch("engager_browser_use.backend.parse_updates", side_effect=[
			rows((1, "me", False, False, None), (2, "me", False, True, None), (3, "me", True, False, None)),
			rows((4, "other", False, False, None), (5, "me", False, False, None), (6, None, False, False, "urn:li:member:7"))]):
			self.assertEqual([p["postUrn"][-1] for p in await backend.fetch_own_posts(3)], ["1", "5", "6"])
		for error, code in ((VoyagerUnavailable("down", transient=True), "BROWSER_TRANSIENT"), (VoyagerUnavailable("odd"), "UI_DRIFT")):
			backend._voyager_get = AsyncMock(side_effect=error)
			with self.assertRaises(SidecarError) as caught:
				await backend.fetch_own_posts(3)
			self.assertEqual(caught.exception.code, code)


class CriticalInvitationsTests(unittest.TestCase):
	def test_received_invitations_read_under_either_state_key(self):
		from engager_browser_use.invitations_data import received_invitations

		keys = {"flat": lambda name: {"value": name}, "nested": lambda name: {"$type": "proto.sdui.StateKey", "value": "", "key": {"$type": "proto.sdui.Key", "value": {"$case": "id", "id": name}}}}
		for shape, key in keys.items():
			state = lambda name, case, value: {"$type": "proto.sdui.State", "key": key(name), "value": {"$case": case, case: value}}
			action = lambda number, kind, member: {"$type": "proto.sdui.actions.core.ServerRequest", "value": {"requestId": "com.linkedin.sdui.requests.mynetwork.addaInvitationAction", "requestedArguments": {"payload": {"invitationType": kind, "invitationUrn": {"invitationId": number}, "profileUrn": {"profileId": member}}}}}
			page = received_invitations([
				{"componentKey": "invitation_manager_row_urn:li:invitation:11", "actions": [action("11", "GenericInvitationType_ORGANIZATION", "page")]},
				{"componentKey": "invitation_manager_row_urn:li:invitation:12", "actions": [action("12", "GenericInvitationType_CONNECTION", "ada")]},
				{"vanityName": "ada-l", "isVanityNameResolved": True, "vieweeProfileId": "ada"},
				{"modelStates": [state("invitation_action_state_11", "stringValue", "Pending"), state("invitation_action_state_12", "stringValue", "Pending"),
					state("invitationManagerReceivedRegularCount", "intValue", 2), state("invitationManagerReceivedHasSpam", "stringValue", "No")]},
			])
			self.assertEqual(([i.sender_id for i in page.invitations], page.others, page.complete), (["ada-l"], 1, True), shape)
