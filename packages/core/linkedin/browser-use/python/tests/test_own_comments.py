"""The account's own comments across the pages of its activity list.

The documents here are SYNTHETIC, in the shape of the comments activity
document and of the pager's responses captured 2026-10-15: flight rows in a
chunked `#rehydrate-data` script; the list a collection keyed
`ProfileRecentActivityComments-<slug>`; each comment's words in a component
tracked as `comment-commentary`, bound by its highlight state; the page's
`isViewerContentOwner`; the pager's request for the next page declared in the
document and, in a response, as a text row. Every slug, id, token and word is
invented.
"""

from __future__ import annotations

import asyncio
import base64
import json
import unittest
import unittest.mock
from types import SimpleNamespace
from typing import Any

from engager_browser_use import backend as backend_module
from engager_browser_use.backend import BrowserUseBackend
from engager_browser_use.own_comments import (
	PAGER_ID,
	PAGINATION_PATH,
	OwnCommentsRead,
	PageUnavailable,
	document_page,
	read_own_comments,
)
from engager_browser_use.protocol import SidecarError
from engager_browser_use.thread_data import Unrecognised

OWNER = "ada-lindqvist"
_COLLECTION = "ProfileRecentActivityComments-"
Comment = tuple[str, str, str, bool]


def numbered(first: int, count: int, *, owned: bool = True) -> list[Comment]:
	return [
		(f"activity:7100000000000{n:06d}", f"7100000000001{n:06d}", f"Words of comment number {n}, long enough to read.", owned)
		for n in range(first, first + count)
	]


def token(number: int) -> str:
	return base64.b64encode(f"urn:li:activity:71000000000000{number:05d}-17900000{number:05d}".encode()).decode()


def pagination(start: int, number: int, *, count: int = 20, slug: str = OWNER) -> dict[str, Any]:
	return {
		"$type": "proto.sdui.actions.requests.PaginationRequest",
		"pagerId": PAGER_ID,
		"retryCount": 1,
		"requestedArguments": {
			"$type": "proto.sdui.actions.requests.RequestedArguments",
			"requestedStateKeys": [],
			"payload": {
				"vanityName": slug,
				"contentType": "ProfileActivityContentType_COMMENTS",
				"feedType": "FeedType_MEMBER_SHARES",
				"collectionReferenceId": f"{_COLLECTION}{slug}",
				"startIndex": start,
				"count": count,
				"token": token(number),
			},
		},
	}


def rows_of(comments: list[Comment]) -> tuple[list[dict[str, Any]], list[str]]:
	items, rows = [], []
	for index, (post, comment, words, owned) in enumerate(comments, start=1):
		urn = f"urn:li:comment:({post},{comment})"
		items.append({"semanticId": urn, "threadlineDecoration": {"threadId": urn}})
		flag = {"isViewerContentOwner": owned, "threadUrn": {"threadUrnCommentThreadUrn": {"commentUrn": {"commentId": comment, "thread": f"urn:li:{post}"}}}}
		highlight = {"bg": {"key": {"value": f"isCommentHighlighted-{urn}Fq9x"}}}
		text = {"textProps": {"children": [words]}}
		commentary = ["$", "$L7b", None, {
			"viewTrackingSpecs": {"viewName": "comment-commentary"},
			"bindableModifiers": highlight,
			"children": ["$", "$L29a", None, text],
		}]
		rows += [f"{index:x}a:{json.dumps(['$', 'div', None, flag])}", f"{index:x}b:{json.dumps(commentary)}"]
	return items, rows


def page(comments: list[Comment], *, slug: str = OWNER, pager: list[dict[str, Any]] | None = None) -> str:
	"""The activity page's document: the list, each comment, and the pager's request."""
	items, rows = rows_of(comments)
	collection = {"collectionId": f"{_COLLECTION}{slug}", "items": items}
	rows = [f"0:{json.dumps(['$', '$L2', None, collection])}", *rows]
	rows += [f"{n:x}d:{json.dumps(['$', '$Lp', None, {'nextPageRequest': request}])}" for n, request in enumerate(pager or [], start=1)]
	text = "\n".join(rows) + "\n"
	cut = [text[:77], text[77:500], text[500:]]
	return (
		'<!DOCTYPE html><html><body><main id="workspace"></main>'
		f'<script type="text/javascript" id="rehydrate-data" nonce="n0nce">window.__como_rehydration__ = {json.dumps(cut)}</script>'
		"</body></html>"
	)


def response(comments: list[Comment], *, request: dict[str, Any] | None = None, collection: str | None = None) -> str:
	"""A page the pager loaded: no collection, the next request as a text row."""
	items, rows = rows_of(comments)
	flight = '1:"030d6035cb3a997efb1cff7a008d2f89"\n2:I["$1",[],"default"]\n'
	refs: list[str] = []
	if request is not None:
		words = json.dumps(request, separators=(",", ":"))
		flight += f"3:T{len(words.encode()):x},{words}"
		refs.append("$3")
	body: dict[str, Any] = {"items": items, "isPartialPage": True}
	if collection is not None:
		body = {"collectionId": collection, **body}
	return flight + "\n".join([f"4:{json.dumps(['$', '$L2', None, body, *refs])}", *rows]) + "\n"


def words_of(read: OwnCommentsRead) -> list[str]:
	return [comment["text"] for comment in read.comments]


class PagesOfTheList(unittest.IsolatedAsyncioTestCase):
	def reader(self, *served: str | Exception) -> tuple[Any, list[Any]]:
		queue, asked = list(served), []

		async def next_page(request: Any) -> str:
			asked.append(request)
			item = queue.pop(0)
			if isinstance(item, Exception):
				raise item
			return item

		return next_page, asked

	async def read(self, document: str, next_page: Any, *, limit: int = 50, max_pages: int = 5) -> OwnCommentsRead:
		return await read_own_comments(document, own_identifier=OWNER, limit=limit, next_page=next_page, max_pages=max_pages)

	async def test_each_page_is_asked_for_by_the_request_the_page_before_declared(self) -> None:
		next_page, asked = self.reader(
			response(numbered(21, 10), request=pagination(40, 2, count=10)),
			response(numbered(31, 10), request=pagination(50, 3, count=10)),
			response(numbered(41, 10)),
		)
		read = await self.read(page(numbered(1, 20), pager=[pagination(20, 1)]), next_page)
		self.assertEqual((words_of(read), read.incomplete), ([c[2] for c in numbered(1, 50)], False))
		self.assertEqual([(r.start_index, r.count, r.token) for r in asked], [(20, 20, token(1)), (40, 10, token(2)), (50, 10, token(3))])
		# What is made of the declaration is the declaration, as declared, and the pager's id.
		self.assertEqual(
			asked[0].body(),
			{
				"pagerId": PAGER_ID,
				"clientArguments": {**pagination(20, 1)["requestedArguments"], "states": [], "knownTemplateIds": []},
				"paginationRequest": pagination(20, 1),
			},
		)

	async def test_a_page_that_is_not_there_returns_what_was_read_as_incomplete(self) -> None:
		for failure in (PageUnavailable("HTTP 429", transient=True), PageUnavailable("HTTP 403")):
			next_page, asked = self.reader(response(numbered(21, 10), request=pagination(40, 2, count=10)), failure)
			read = await self.read(page(numbered(1, 20), pager=[pagination(20, 1)]), next_page)
			self.assertEqual((words_of(read), read.incomplete), ([c[2] for c in numbered(1, 30)], True))
			self.assertEqual(len(asked), 2)

	async def test_pages_that_run_out_before_the_limit_are_incomplete(self) -> None:
		next_page, _ = self.reader(response(numbered(21, 10), request=pagination(40, 2, count=10)))
		read = await self.read(page(numbered(1, 20), pager=[pagination(20, 1)]), next_page, max_pages=2)
		self.assertEqual((len(read.comments), read.incomplete), (30, True))

	async def test_a_list_that_ends_or_meets_the_limit_is_whole(self) -> None:
		next_page, asked = self.reader(response(numbered(21, 5)))
		read = await self.read(page(numbered(1, 20), pager=[pagination(20, 1)]), next_page)
		self.assertEqual((len(read.comments), read.incomplete), (25, False))
		next_page, asked = self.reader()
		read = await self.read(page(numbered(1, 20), pager=[pagination(20, 1)]), next_page, limit=20)
		self.assertEqual((len(read.comments), read.incomplete, asked), (20, False, []))

	async def test_nothing_read_is_a_failure_not_an_empty_read(self) -> None:
		next_page, _ = self.reader(PageUnavailable("HTTP 500", transient=True))
		with self.assertRaises(PageUnavailable):
			await self.read(page([], pager=[pagination(20, 1)]), next_page)

	async def test_a_foreign_or_malformed_page_still_fails_the_whole_read(self) -> None:
		first = page(numbered(1, 20), pager=[pagination(20, 1)])
		follows = pagination(40, 2, count=20)
		for served in (
			# Another profile's list.
			response(numbered(21, 20), request=follows, collection=f"{_COLLECTION}someone-else"),
			# Its pager request for another profile's list.
			response(numbered(21, 20), request=pagination(40, 2, slug="someone-else")),
			# A page that does not advance by the count asked, or repeats the token.
			response(numbered(21, 20), request=pagination(60, 2)),
			response(numbered(21, 20), request={**follows, "requestedArguments": {**follows["requestedArguments"], "payload": {**follows["requestedArguments"]["payload"], "token": token(1)}}}),
			# Comments the account does not own, a list that goes on with none, and data that is not a flight.
			response(numbered(21, 20, owned=False), request=follows),
			response([], request=follows),
			"<html>login</html>",
		):
			next_page, _ = self.reader(served)
			with self.assertRaises(Unrecognised):
				await self.read(first, next_page)
		# A token any earlier request carried is a loop, not only the one before.
		next_page, _ = self.reader(response(numbered(21, 10), request=pagination(40, 2, count=10)), response(numbered(31, 10), request=pagination(50, 1, count=10)))
		with self.assertRaises(Unrecognised):
			await self.read(first, next_page)
		# A failure after a page was read does not turn a malformed page into a partial read.
		next_page, _ = self.reader(response(numbered(21, 20), request=pagination(60, 2)))
		with self.assertRaises(Unrecognised):
			await self.read(first, next_page)

	def test_the_document_declares_the_request(self) -> None:
		first = document_page(page(numbered(1, 3), pager=[pagination(20, 1)]), own_identifier=OWNER)
		self.assertEqual((first.next.start_index, first.next.token), (20, token(1)))  # type: ignore[union-attr]


class DeclaredRequest(unittest.IsolatedAsyncioTestCase):
	"""`_next_own_comments_page`: the pager when it runs, else the declared request."""

	REQUEST = document_page(page(numbered(1, 3), pager=[pagination(20, 1)]), own_identifier=OWNER).next

	RSC = {"x-li-page-instance": "urn:li:page:d_flagship3_profile_creator_profile_comments_content_view;abc", "x-li-track": "{\"mpName\":\"web\"}"}

	def backend(
		self,
		answer: Any,
		*,
		pager_runs: bool = False,
		pager_starts: bool = False,
		headers: dict[str, str] | None = None,
		focus_off_fails: bool = False,
	) -> tuple[BrowserUseBackend, list[tuple[Any, ...]]]:
		calls: list[tuple[Any, ...]] = []
		focus: list[bool] = []
		self.focus = focus
		handlers: dict[str, Any] = {}

		async def enable(*, params: Any = None, session_id: str | None = None) -> None:
			return None

		async def get_body(*, params: dict[str, Any], session_id: str) -> dict[str, Any]:
			return {"body": "scrolled flight\n", "base64Encoded": False}

		async def emulate(*, params: dict[str, Any], session_id: str) -> None:
			focus.append(params["enabled"])
			if focus_off_fails and not params["enabled"]:
				raise RuntimeError("the tab is unresponsive")

		cdp = SimpleNamespace(
			send=SimpleNamespace(
				Network=SimpleNamespace(enable=enable, getResponseBody=get_body),
				Emulation=SimpleNamespace(setFocusEmulationEnabled=emulate),
			),
			register=SimpleNamespace(
				Network=SimpleNamespace(
					requestWillBeSent=lambda handler: handlers.__setitem__("requested", handler),
					responseReceived=lambda handler: handlers.__setitem__("received", handler),
					loadingFinished=lambda handler: handlers.__setitem__("finished", handler),
				)
			),
		)

		async def started() -> None:
			return None

		async def session(target_id: str) -> Any:
			return SimpleNamespace(cdp_client=cdp, session_id="page-session")

		async def evaluate_json(script: str, *args: Any) -> Any:
			calls.append((script, *args))
			if script is backend_module.SCROLL_ACTIVITY_LIST_JS:
				url = "https://www.linkedin.com" + PAGINATION_PATH
				if pager_runs or pager_starts:
					handlers["requested"]({"requestId": "7", "request": {"url": url, "headers": {}}}, "page-session")
				if pager_runs:
					handlers["received"]({"requestId": "7", "type": "Fetch", "response": {"url": url}}, "page-session")
					handlers["finished"]({"requestId": "7"}, "page-session")
				return {"scrolled": True}
			if isinstance(answer, Exception):
				raise answer
			return answer

		async def identity(since: float) -> dict[str, str]:
			return {}

		backend = BrowserUseBackend()
		backend._start = started  # type: ignore[method-assign]
		backend._evaluate_json = evaluate_json  # type: ignore[method-assign]
		backend._page_identity = identity  # type: ignore[method-assign]
		backend._browser = SimpleNamespace(session_for=session)
		backend._page = SimpleNamespace(target_id="page-target")  # type: ignore[assignment]
		backend._visit = SimpleNamespace(opened_at=0.0)  # type: ignore[assignment]
		backend._rsc_headers_seen.headers = self.RSC if headers is None else headers
		return backend, calls

	async def asyncSetUp(self) -> None:
		patcher = unittest.mock.patch.object(backend_module, "OWN_COMMENTS_SCROLL_WAIT_S", 0.3)
		patcher.start()
		self.addCleanup(patcher.stop)

	async def test_makes_the_declared_request_from_the_page_when_the_scroll_yields_nothing(self) -> None:
		backend, calls = self.backend({"frame": "page", "status": 200, "body": "2:I[]\n"})
		self.assertEqual(await backend._next_own_comments_page(self.REQUEST), "2:I[]\n")
		self.assertIsNone(backend._network_tap.capture)
		scroll, post = calls
		self.assertIs(scroll[0], backend_module.SCROLL_ACTIVITY_LIST_JS)
		script, path, body, headers, _timeout, max_bytes = post
		self.assertEqual(max_bytes, backend_module.OWN_COMMENT_PAGE_BYTES)
		self.assertIs(script, backend_module.OWN_COMMENTS_PAGE_JS)
		self.assertEqual(path, PAGINATION_PATH)
		self.assertEqual(json.loads(body), self.REQUEST.body())  # type: ignore[union-attr]
		self.assertEqual(json.loads(headers), self.RSC)
		# The scroll ran with the page made to think it is focused, and left that off.
		self.assertEqual(self.focus, [True, False])
		# The scroll is not tried again in this read.
		self.assertFalse(backend._own_comments_scroll)
		await backend._next_own_comments_page(self.REQUEST)
		self.assertEqual(len(calls), 3)

	async def test_keeps_the_pagers_own_response_when_it_runs(self) -> None:
		backend, calls = self.backend(AssertionError("no request is made"), pager_runs=True)
		self.assertEqual(await backend._next_own_comments_page(self.REQUEST), "scrolled flight\n")
		self.assertEqual(len(calls), 1)

	async def test_a_pager_request_that_is_slow_is_waited_for_never_made_twice(self) -> None:
		with unittest.mock.patch.object(backend_module, "OWN_COMMENTS_PAGE_WAIT_S", 0.3):
			backend, calls = self.backend(AssertionError("no second request"), pager_starts=True)
			with self.assertRaises(PageUnavailable):
				await backend._next_own_comments_page(self.REQUEST)
		self.assertEqual(len(calls), 1)
		self.assertEqual(self.focus, [True, False])

	async def test_focus_emulation_not_confirmed_off_discards_the_tab_and_ends_the_read(self) -> None:
		backend, _ = self.backend({"status": 200, "body": "x"}, focus_off_fails=True)
		discarded: list[bool] = []

		async def discard() -> None:
			discarded.append(True)
			backend._own_comments_tab_lost = True

		backend._discard_own_comments_tab = discard  # type: ignore[method-assign]
		with self.assertRaisesRegex(PageUnavailable, "discarded"):
			await backend._next_own_comments_page(self.REQUEST)
		self.assertEqual(discarded, [True])
		with self.assertRaisesRegex(PageUnavailable, "discarded"):
			await backend._next_own_comments_page(self.REQUEST)

	async def test_a_page_over_the_ceiling_or_past_the_deadline_is_a_page_not_there(self) -> None:
		backend, calls = self.backend({"status": 200, "tooLarge": True})
		with self.assertRaisesRegex(PageUnavailable, "larger"):
			await backend._next_own_comments_page(self.REQUEST)
		backend, calls = self.backend({"status": 200, "body": "x"})
		backend._own_comments_deadline = 0.0
		with self.assertRaisesRegex(PageUnavailable, "ran out of time"):
			await backend._next_own_comments_page(self.REQUEST)
		self.assertEqual(calls, [])

	async def test_a_declared_request_that_is_refused_or_unanswered_is_a_page_not_there(self) -> None:
		for answer, transient in (
			({"status": 429, "body": ""}, True),
			({"status": 403, "body": ""}, False),
			({"status": 0, "error": "timed out"}, True),
			(SidecarError("BROWSER_TRANSIENT", "browser evaluation failed", retryable=True), True),
		):
			backend, _ = self.backend(answer)
			with self.assertRaises(PageUnavailable) as failed:
				await backend._next_own_comments_page(self.REQUEST)
			self.assertEqual(failed.exception.transient, transient)

	async def test_a_page_that_named_itself_by_no_headers_is_not_made_requests_in(self) -> None:
		backend, calls = self.backend({"status": 200, "body": "x"}, headers={})
		with self.assertRaisesRegex(PageUnavailable, "x-li-page-instance, x-li-track"):
			await backend._next_own_comments_page(self.REQUEST)
		self.assertEqual(len(calls), 1)

	async def test_fetch_own_comments_returns_the_pages_it_read_as_incomplete(self) -> None:
		backend = BrowserUseBackend()
		backend._own_profile_url = f"https://www.linkedin.com/in/{OWNER}"

		async def on_page(url: str, address: Any, what: str, **kwargs: Any) -> Any:
			self.assertEqual(url, f"https://www.linkedin.com/in/{OWNER}/recent-activity/comments/")
			return SimpleNamespace(document=page(numbered(1, 20), pager=[pagination(20, 1)]))

		async def ready() -> None:
			return None

		async def unavailable(request: Any) -> str:
			raise PageUnavailable("HTTP 500", transient=True)

		backend._on_page = on_page  # type: ignore[method-assign]
		backend._assert_landed_ready = ready  # type: ignore[method-assign]
		backend._next_own_comments_page = unavailable  # type: ignore[method-assign]
		read = await backend.fetch_own_comments(50)
		self.assertEqual((len(read.comments), read.incomplete), (20, True))

		backend._on_page = lambda *a, **k: asyncio.sleep(0, SimpleNamespace(document=page([], pager=[pagination(20, 1)])))  # type: ignore[method-assign]
		with self.assertRaises(SidecarError) as failed:
			await backend.fetch_own_comments(50)
		self.assertEqual((failed.exception.code, failed.exception.retryable), ("BROWSER_TRANSIENT", True))


if __name__ == "__main__":
	unittest.main()
