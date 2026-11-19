"""The account's own comments, read from its comments activity page's own data.

`/in/<slug>/recent-activity/comments/` is server-driven: the document LinkedIn
serves for it carries the list as React flight rows (`thread_data.py`), and
the page's first screen of comments is in it (read in the document captured
2026-10-15). The rest of the list loads in pages, below. What this module reads,
and nothing else:

- the list itself: a collection keyed `ProfileRecentActivityComments-<slug>`
  — the comments of exactly that profile, which must be the account's own;
- each comment's words: the component tracked as `comment-commentary`, whose
  text block's children are the words, bound to its comment by the state key
  it highlights the comment with (`isCommentHighlighted-<comment urn>…`);
- who wrote it: the page's own `isViewerContentOwner`, keyed by the comment's
  thread (`threadUrnCommentThreadUrn.commentUrn {commentId, thread}`) — true
  is the signed-in account, and only a comment it marks true is ours;
- the post it is on: the comment urn's own thread, `urn:li:comment:
  (activity:<id>,<id>)` or `(ugcPost:<id>,<id>)`.

No markup decides anything, and a comment's words are never guessed from a
neighbour's. FAIL CLOSED: a document with no such list, or a list of another
profile's, is Unrecognised — the read fails, and a relearn never learns from
an empty read it took for none. So is a list whose items name comments of which
none could be read: an empty list is the only empty read. A comment whose words
are not plain text, or that the page does not mark the account's, is left out.

The list goes on in pages. The document's first screen declares the request
LinkedIn's own pager makes for the next (`nextPageRequest`: `startIndex`,
`count`, and a `token`), and scrolling the page's scroller to its end makes the
pager make it — a POST whose response is the same flight, ~10 more comments and
the request for the page after it (captured 2026-10-15, pages 2-7). Nothing is
forged: the caller scrolls, keeps the response the page received, and hands it
to `response_page`. A response is read as the document is, less the collection
(it names none): the next request it declares must be for the account's own
list, and each comment still counts only where the page marks the account its
owner.

FAIL CLOSED, past the first page too. A page that is not read as the page that
follows the one before it — a request that does not advance by the `count` it
asked, or repeats a token already asked with — a page that lists nothing while the list goes on,
or any data this cannot read, is Unrecognised: the read fails, and is never the
comments read so far presented as all. The list ends where a page declares no
next request. At most `OWN_COMMENT_PAGES` pages are read.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import unquote

from .replies import clean
from .thread_data import Unrecognised, flight_from_page, flight_values, script_from_document

# The most pages one read takes: the document's, and each one LinkedIn's pager
# loads after it. The first holds ~20 comments and those after it ~10 (read
# 2026-10-15), so five reach past the fifty a relearn asks for, and a read
# never scrolls an unbounded list.
OWN_COMMENT_PAGES = 5

PAGER_ID = "com.linkedin.sdui.pagers.profile.ActivityDetail"
# The address of the pager's POST (captured 2026-10-15); its body is
# `PageRequest.body`.
PAGINATION_PATH = f"/flagship-web/rsc-action/actions/pagination?sduiid={PAGER_ID}"
_PAGINATION_REQUEST = "proto.sdui.actions.requests.PaginationRequest"
_COMMENTS_CONTENT = "ProfileActivityContentType_COMMENTS"
_COLLECTION_PREFIX = "ProfileRecentActivityComments-"
_COMMENTARY_VIEW = "comment-commentary"
_HIGHLIGHT_RE = re.compile(r"isCommentHighlighted-(urn:li:comment:\((activity|ugcPost):(\d+),(\d+)\))")
_COMMENT_URN_RE = re.compile(r"urn:li:comment:\((activity|ugcPost):(\d+),(\d+)\)")


@dataclass(frozen=True)
class PageRequest:
	"""The request LinkedIn's own pager makes for the next page of the list."""

	start_index: int
	count: int
	token: str
	# The request as the document declared it: `body` is made of nothing else.
	# Not part of which request this is — two declarations of one position are
	# one request.
	declared: dict[str, Any] = field(default_factory=dict, compare=False, hash=False)

	def body(self) -> dict[str, Any]:
		"""The POST body of the request, as the pager sends it (captured
		2026-10-29): the pager's id, the arguments it declared as
		`clientArguments` — with the empty `states` and `knownTemplateIds` the
		client adds — and the declared request itself as `paginationRequest`."""
		arguments = self.declared.get("requestedArguments")
		return {
			"pagerId": PAGER_ID,
			"clientArguments": {**(arguments if isinstance(arguments, dict) else {}), "states": [], "knownTemplateIds": []},
			"paginationRequest": self.declared,
		}


class PageUnavailable(Exception):
	"""The next page of the list could not be had: its request was refused or
	never answered, or the answer was lost. Not that the data is wrong
	(Unrecognised), only that it did not come. `transient` is whether asking
	again may do."""

	def __init__(self, message: str, *, transient: bool = False) -> None:
		super().__init__(message)
		self.transient = transient


@dataclass(frozen=True)
class OwnCommentsRead:
	"""The comments read, `{text, postUrn}` in the list's order, and whether the
	list went on past them: `incomplete` where a page that was to follow could
	not be had, or the pages ran out before `limit`."""

	comments: list[dict[str, str]]
	incomplete: bool = False


@dataclass(frozen=True)
class OwnComment:
	urn: str
	text: str
	post_urn: str

	def wire(self) -> dict[str, str]:
		return {"text": self.text, "postUrn": self.post_urn}


@dataclass(frozen=True)
class CommentsPage:
	"""One page of the list: the account's comments it lets us read, in list
	order, how many comments it lists in all, and the request for the next page
	— None where it declares none, which is the end of the list."""

	comments: list[OwnComment]
	listed: int
	next: PageRequest | None


@dataclass
class _Data:
	collections: set[str] = field(default_factory=set)
	# Every comment urn the list's items name, whatever else they carry.
	items: list[str] = field(default_factory=list)
	# Those among them the page marks as list items (`threadlineDecoration`),
	# in list order.
	listed: list[str] = field(default_factory=list)
	# Words by comment urn; None where a commentary's words were not plain text.
	words: dict[str, list[str | None]] = field(default_factory=dict)
	# Whether the viewer owns it, by comment id.
	owned: dict[str, set[bool]] = field(default_factory=dict)
	# The pager's requests for its next page, as declared.
	requests: list[dict[str, Any]] = field(default_factory=list)


def own_comments(document: str, *, own_identifier: str, limit: int) -> list[dict[str, str]]:
	"""The account's own comments in the first screen of the document LinkedIn
	served for its comments activity page — `{text, postUrn}`, in the list's
	order, at most `limit` — or Unrecognised."""
	page = document_page(document, own_identifier=own_identifier)
	return [comment.wire() for comment in page.comments[:limit]]


async def read_own_comments(
	document: str,
	*,
	own_identifier: str,
	limit: int,
	next_page: Callable[[PageRequest], Awaitable[str]],
	max_pages: int = OWN_COMMENT_PAGES,
) -> OwnCommentsRead:
	"""The account's own comments across the pages of its comments activity
	list — `{text, postUrn}`, in the list's order, at most `limit`, from at most
	`max_pages` pages — or Unrecognised.

	The document is the first page. While the page read declares a request for
	the next, fewer than `limit` comments are read, and pages remain,
	`next_page` gets the flight that request answers (LinkedIn's own pager makes
	it, or the declared request is made from the page). Each page must be the
	one that follows: it declares the request after the one just asked for.
	Where the next page is not there (`PageUnavailable`) or the pages run out
	with the list still going on, what was read is returned `incomplete`."""
	page = document_page(document, own_identifier=own_identifier)
	comments = {comment.urn: comment for comment in page.comments}
	pages = 1
	incomplete = False
	tokens = {page.next.token} if page.next is not None else set()
	while len(comments) < limit and page.next is not None:
		if pages >= max_pages:
			incomplete = True
			break
		asked = page.next
		try:
			flight = await next_page(asked)
		except PageUnavailable:
			if not comments:
				raise
			incomplete = True
			break
		page = response_page(flight, own_identifier=own_identifier)
		pages += 1
		if page.listed == 0 and page.next is not None:
			raise Unrecognised(f"page {pages} lists no comments, and the list goes on")
		if page.next is not None and (
			page.next.start_index != asked.start_index + asked.count or page.next.token in tokens
		):
			raise Unrecognised(f"page {pages} is not the one that follows the page before it")
		if page.next is not None:
			tokens.add(page.next.token)
		for comment in page.comments:
			comments.setdefault(comment.urn, comment)
	return OwnCommentsRead([comment.wire() for comment in comments.values()][:limit], incomplete)


def document_page(document: str, *, own_identifier: str) -> CommentsPage:
	"""The first screen of the list in the document LinkedIn served for the
	comments activity page, or Unrecognised. The list must be the account's
	own."""
	flight = flight_from_page({"script": script_from_document(document)})
	data, texts = _read_flight(flight)
	if not data.collections:
		raise Unrecognised("the page's data lists no comments activity")
	_assert_own_list(data, own_identifier)
	return _page(data, texts, own_identifier)


def response_page(flight: str, *, own_identifier: str) -> CommentsPage:
	"""A page of the list that LinkedIn's pager loaded, in the flight its
	response carried, or Unrecognised. It names no collection; if it does, it
	must be the account's own."""
	data, texts = _read_flight(flight)
	if data.collections:
		_assert_own_list(data, own_identifier)
	return _page(data, texts, own_identifier)


def _read_flight(flight: str) -> tuple[_Data, list[bytes]]:
	texts: list[bytes] = []
	values = flight_values(flight, text_rows=texts)
	if not values and not texts:
		raise Unrecognised("the data carries no rows")
	return _read(values), texts


def _assert_own_list(data: _Data, own_identifier: str) -> None:
	owners = {unquote(name[len(_COLLECTION_PREFIX) :]).casefold() for name in data.collections}
	if owners != {unquote(own_identifier).casefold()}:
		raise Unrecognised("the comments activity listed is not the account's own")


def _page(data: _Data, texts: list[bytes], own_identifier: str) -> CommentsPage:
	listed = list(dict.fromkeys(data.listed))
	out: list[OwnComment] = []
	for urn in listed:
		match = _COMMENT_URN_RE.fullmatch(urn)
		if match is None or data.owned.get(match.group(3)) != {True}:
			continue
		words = data.words.get(urn, [])
		if len(words) != 1 or words[0] is None or not words[0]:
			continue
		out.append(OwnComment(urn=urn, text=words[0], post_urn=f"urn:li:{match.group(1)}:{match.group(2)}"))
	if not out and (data.items or listed):
		raise Unrecognised("the page lists comments, and none of them could be read as the account's")
	return CommentsPage(comments=out, listed=len(listed), next=_next_request(data, texts, own_identifier))


def _next_request(data: _Data, texts: list[bytes], own_identifier: str) -> PageRequest | None:
	"""The one request the page declares for the next page of the account's
	list, or None where it declares none. The pager's request is declared in a
	row of the document, and as a text row of a page it loaded."""
	declared = list(data.requests)
	for words in texts:
		if _PAGINATION_REQUEST.encode() not in words:
			continue
		try:
			declared.extend(_pager_requests(json.loads(words)))
		except json.JSONDecodeError as exc:
			raise Unrecognised("a text row naming the pager's request is not JSON") from exc
	requests = {_page_request(value, own_identifier) for value in declared}
	if len(requests) > 1:
		raise Unrecognised("the page declares two requests for the next page")
	return next(iter(requests), None)


def _page_request(value: dict[str, Any], own_identifier: str) -> PageRequest:
	arguments = value.get("requestedArguments")
	payload = arguments.get("payload") if isinstance(arguments, dict) else None
	if not isinstance(payload, dict) or payload.get("contentType") != _COMMENTS_CONTENT:
		raise Unrecognised("the pager's next request is not for the comments list")
	owner = unquote(own_identifier).casefold()
	vanity, collection = payload.get("vanityName"), payload.get("collectionReferenceId")
	if (
		not isinstance(vanity, str)
		or unquote(vanity).casefold() != owner
		or not isinstance(collection, str)
		or unquote(collection).casefold() != f"{_COLLECTION_PREFIX}{owner}".casefold()
	):
		raise Unrecognised("the pager's next request is for a list that is not the account's own")
	start, count, token = payload.get("startIndex"), payload.get("count"), payload.get("token")
	if (
		isinstance(start, bool)
		or not isinstance(start, int)
		or start < 0
		or isinstance(count, bool)
		or not isinstance(count, int)
		or count < 1
		or not isinstance(token, str)
		or not token
	):
		raise Unrecognised("the pager's next request carries no position")
	return PageRequest(start_index=start, count=count, token=token, declared=value)


def _is_pager_request(value: dict[str, Any]) -> bool:
	return value.get("$type") == _PAGINATION_REQUEST and value.get("pagerId") == PAGER_ID


def _pager_requests(value: Any) -> list[dict[str, Any]]:
	"""Every request in a value that the comments list's pager makes."""
	found: list[dict[str, Any]] = []
	stack: list[Any] = [value]
	while stack:
		value = stack.pop()
		if isinstance(value, list):
			stack.extend(reversed(value))
		elif isinstance(value, dict):
			if _is_pager_request(value):
				found.append(value)
			stack.extend(reversed(list(value.values())))
	return found


def _read(values: list[Any]) -> _Data:
	data = _Data()
	stack: list[Any] = list(reversed(values))
	while stack:
		value = stack.pop()
		if isinstance(value, list):
			stack.extend(reversed(value))
			continue
		if not isinstance(value, dict):
			continue
		collection = value.get("collectionId")
		if isinstance(collection, str) and collection.startswith(_COLLECTION_PREFIX):
			data.collections.add(collection)
			items = value.get("items")
			for entry in items if isinstance(items, list) else []:
				named = entry.get("semanticId") if isinstance(entry, dict) else None
				if isinstance(named, str) and _COMMENT_URN_RE.fullmatch(named):
					data.items.append(named)
		semantic = value.get("semanticId")
		if isinstance(semantic, str) and _COMMENT_URN_RE.fullmatch(semantic) and "threadlineDecoration" in value:
			data.listed.append(semantic)
		tracking = value.get("viewTrackingSpecs")
		if isinstance(tracking, dict) and tracking.get("viewName") == _COMMENTARY_VIEW:
			_keep_commentary(data, value)
		if isinstance(value.get("isViewerContentOwner"), bool):
			_keep_owner(data, value)
		if _is_pager_request(value):
			data.requests.append(value)
		stack.extend(reversed(list(value.values())))
	return data


def _keep_commentary(data: _Data, component: dict[str, Any]) -> None:
	"""One commentary's words, under the one comment its highlight binds."""
	urns = {match.group(1) for match in _HIGHLIGHT_RE.finditer(json.dumps(component.get("bindableModifiers")))}
	if len(urns) != 1:
		return
	(urn,) = urns
	children = component.get("children")
	props = children[3] if isinstance(children, list) and len(children) == 4 else None
	text_props = props.get("textProps") if isinstance(props, dict) else None
	parts = text_props.get("children") if isinstance(text_props, dict) else None
	words: str | None = None
	if isinstance(parts, list) and parts and all(isinstance(part, str) and not part.startswith("$") for part in parts):
		words = clean("".join(parts))
	data.words.setdefault(urn, []).append(words)


def _keep_owner(data: _Data, value: dict[str, Any]) -> None:
	"""Whether the viewer owns the comment the value's thread names."""
	thread = value.get("threadUrn")
	thread = thread.get("threadUrnCommentThreadUrn") if isinstance(thread, dict) else None
	comment = thread.get("commentUrn") if isinstance(thread, dict) else None
	comment_id = comment.get("commentId") if isinstance(comment, dict) else None
	if isinstance(comment_id, str) and comment_id.isdigit():
		data.owned.setdefault(comment_id, set()).add(value["isViewerContentOwner"])
