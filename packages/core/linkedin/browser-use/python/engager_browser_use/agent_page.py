"""A LinkedIn page as the agent reader reads it.

`replies.py` and `messaging.py` read a page by its structure, and a redesign
that moves the structure reads as nothing at all: on 2026-10-12 every reply
under our comments read as none, because the post page renders a reply as a
row beside its parent rather than under it. The agent reader takes the other
road. This module turns the page's markup into compact text a model can read;
core sends it to the owner's model and checks every identifier the answer cites
against this same text before anything is recorded. Which comment a row
answers is the PAGE's word, never the model's — the row's nesting, or the
redesign's thread beside a comment as LinkedIn's own count vouches for it
(`replies.reply_parents`) — and nothing a model says is ever evidence for a
write.

The inbox is LinkedIn's own conversation data rather than markup: where the
compose view's load fetched it, `json_representation` reads it the same way —
words and anchors, shape-blind, so a list the parser no longer recognises still
reads.

What survives of the page: its words in document order, a line per block, and
ANCHORS — the identifiers a model may cite and the server can verify:

  ⟦item URN⟧ … ⟦/item⟧   an element keyed by a LinkedIn urn: a message, a post
  ⟦item URN kind=comment⟧, ⟦item URN kind=reply parent=URN⟧
                         a comment row, and which comment a reply answers
  ⟦body⟧ … ⟦/body⟧       a comment's own words, apart from its controls
  ⟦profile URL⟧          a link to a member's or a company's page
  ⟦thread ID⟧            a link to a conversation
  ⟦button LABEL⟧         a control, by its label — named, never pressed
  ⟦aria LABEL⟧           an accessible label that is not the element's own words

The page cannot forge an anchor: the two brackets are taken out of every word,
label and address it carries. A composer is left out whole — the words in it
are someone's unsent draft. Past MAX_REPRESENTATION_BYTES the text is cut,
keeping the window that starts at the focus item when there is one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote, urlparse

from .conversations import COMPOSE_URL
from .messaging import THREAD_ID_RE, thread_id_of
from .protocol import SidecarError
from .replies import Element, _Page, clean, comment_id, is_body, profile_identity, reply_parents

ANCHOR_OPEN = "⟦"
ANCHOR_CLOSE = "⟧"

# What one read hands the model: about 30 KB, a few thousand tokens.
MAX_REPRESENTATION_BYTES = 30_000
# How much of the page before the focus item a cut text keeps.
FOCUS_LEAD_BYTES = 2_000
MAX_LABEL = 200

AGENT_READ_INTENTS = frozenset({"comment_replies", "inbox", "dm_thread"})
INBOX_URL = "https://www.linkedin.com/messaging/"

# The attributes an element is keyed by: the redesign's `componentkey` (with a
# kind prefix before the urn), the legacy `data-id` / `data-urn`, a message's
# `data-event-urn`, and an `id` that repeats the key.
_KEY_ATTRIBUTES = ("componentkey", "data-urn", "data-event-urn", "data-id", "id")
_URN_RE = re.compile(r"urn:li:[A-Za-z_]+:[^\s⟦⟧]{1,300}")
_SILENT_TAGS = frozenset({"script", "style", "template", "noscript", "svg", "textarea", "input", "select"})
_BLOCK_TAGS = frozenset(
	{
		"address", "article", "aside", "blockquote", "dd", "div", "dl", "dt", "figcaption", "figure",
		"footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "li", "main", "nav", "ol", "p",
		"pre", "section", "table", "tr", "ul",
	}
)
_POST_URL_RE = re.compile(r"https://www\.linkedin\.com/feed/update/(urn:li:(?:activity|ugcPost|share):[0-9]{1,30})/?")
_THREAD_URL_RE = re.compile(r"https://www\.linkedin\.com/messaging/thread/([^/?#]{1,200})/?")


def _plain(value: str) -> str:
	"""Page words with the anchor brackets taken out, whitespace collapsed."""
	return clean(value.replace(ANCHOR_OPEN, " ").replace(ANCHOR_CLOSE, " "))


def _label(value: str) -> str:
	return _plain(value)[:MAX_LABEL]


def item_urn(element: Element) -> str | None:
	"""The LinkedIn urn an element is keyed by, whatever kind prefix the key
	carries before it."""
	for name in _KEY_ATTRIBUTES:
		value = element.get(name)
		if not value or "urn:li:" not in value:
			continue
		urn = value[value.index("urn:li:"):]
		if _URN_RE.fullmatch(urn):
			return urn
	return None


def _composer(element: Element) -> bool:
	"""A box someone types in: what it holds is an unsent draft."""
	editable = element.get("contenteditable")
	return editable is not None and editable.lower() != "false"


class _Lines:
	def __init__(self) -> None:
		self.lines: list[str] = []
		self._current: list[str] = []

	def add(self, words: str) -> None:
		if words:
			self._current.append(words)

	def end_line(self) -> None:
		if self._current:
			self.lines.append(" ".join(self._current))
			self._current = []

	def own_line(self, marker: str) -> None:
		self.end_line()
		self.lines.append(marker)


def _row_kinds(root: Element) -> dict[int, str]:
	"""What each comment row's item anchor says of it, by the row's element:
	a comment, or a reply and the comment it answers — the page's word
	(`replies.reply_parents`), which the server holds a model's answer to."""
	page = _Page(root)
	parents = reply_parents(page)
	return {
		id(row.element): f" kind=reply parent={parents[row.id].urn}" if row.id in parents else " kind=comment"
		for row in page.rows.values()
		if len(row.innermost) == 1
	}


def _walk(element: Element, out: _Lines, kinds: dict[int, str], open_urns: set[str], depth: int) -> None:
	if element.tag in _SILENT_TAGS or element.get("hidden") is not None or _composer(element) or depth > 400:
		return
	urn = item_urn(element)
	# A row keyed twice — the redesign's wrapper and its reference both carry
	# the urn — is one item.
	anchor = urn if urn is not None and urn not in open_urns else None
	if anchor is not None:
		open_urns.add(anchor)
		out.own_line(f"{ANCHOR_OPEN}item {anchor}{kinds.get(id(element), '')}{ANCHOR_CLOSE}")
	block = element.tag in _BLOCK_TAGS
	if block:
		out.end_line()
	body = is_body(element)
	if body:
		out.add(f"{ANCHOR_OPEN}body{ANCHOR_CLOSE}")
	aria = _label(element.get("aria-label") or "")
	if element.tag == "a":
		identity = profile_identity(element.get("href"))
		thread = thread_id_of(element.get("href"))
		if identity is not None:
			out.add(f"{ANCHOR_OPEN}profile {_plain(identity[1])}{ANCHOR_CLOSE}")
		elif thread is not None and THREAD_ID_RE.fullmatch(thread):
			out.add(f"{ANCHOR_OPEN}thread {thread}{ANCHOR_CLOSE}")
	# A control with no label of its own is named by its words, said once.
	said = False
	if element.tag == "button":
		out.add(f"{ANCHOR_OPEN}button {aria or _label(element.words())}{ANCHOR_CLOSE}")
		said = not aria
	elif aria and aria != _plain(element.words()):
		out.add(f"{ANCHOR_OPEN}aria {aria}{ANCHOR_CLOSE}")
	for child in [] if said else element.children:
		if isinstance(child, str):
			out.add(_plain(child))
		elif child.tag == "br":
			out.end_line()
		else:
			_walk(child, out, kinds, open_urns, depth + 1)
	if body:
		out.add(f"{ANCHOR_OPEN}/body{ANCHOR_CLOSE}")
	if block:
		out.end_line()
	if anchor is not None:
		out.own_line(f"{ANCHOR_OPEN}/item{ANCHOR_CLOSE}")
		open_urns.discard(anchor)


def _size(line: str) -> int:
	return len(line.encode("utf-8")) + 1


def _focus_index(lines: list[str], focus: str | None) -> int | None:
	if focus is None:
		return None
	wanted = comment_id(focus) or focus
	for index, line in enumerate(lines):
		if line.startswith(f"{ANCHOR_OPEN}item ") and line.endswith(ANCHOR_CLOSE):
			urn = line[len(ANCHOR_OPEN) + 5 : -len(ANCHOR_CLOSE)].split(" ", 1)[0]
			if (comment_id(urn) or urn) == wanted:
				return index
	return None


def page_representation(root: Element, *, focus: str | None = None) -> dict[str, Any]:
	"""The page as the agent reader's text: `text`, and whether it was cut."""
	out = _Lines()
	_walk(root, out, _row_kinds(root), set(), 0)
	out.end_line()
	return _capped(out.lines, focus)


def json_representation(body: Any) -> dict[str, Any]:
	"""LinkedIn's own JSON as the agent reader's text: `text`, and whether it
	was cut. Shape-blind on purpose — it reads what moved as readily as what
	did not: a conversation's own address is a ⟦thread ID⟧ and a member's or a
	page's a ⟦profile URL⟧, every `text` is its words, a count or a flag is
	`key: value`, and each object and each anchor opens a line of its own, in
	the order the response holds them. Urns, images and LinkedIn's bookkeeping say nothing."""
	out = _Lines()
	_walk_json(body, None, out, 0)
	out.end_line()
	return _capped(out.lines, None)


def _walk_json(value: Any, key: str | None, out: _Lines, depth: int) -> None:
	if depth > 60:
		return
	if isinstance(value, dict):
		out.end_line()
		for name, item in value.items():
			if not name.startswith(("_", "$")):
				_walk_json(item, name, out, depth + 1)
		out.end_line()
	elif isinstance(value, list):
		for item in value:
			_walk_json(item, key, out, depth + 1)
	elif isinstance(value, str):
		thread = thread_id_of(value) if value.startswith("https://") else None
		identity = profile_identity(value) if value.startswith("https://") else None
		if thread is not None and THREAD_ID_RE.fullmatch(thread):
			out.own_line(f"{ANCHOR_OPEN}thread {thread}{ANCHOR_CLOSE}")
		elif identity is not None:
			out.own_line(f"{ANCHOR_OPEN}profile {_plain(identity[1])}{ANCHOR_CLOSE}")
		elif key == "text":
			out.add(_plain(value))
	elif isinstance(value, bool) and key is not None:
		out.add(f"{_label(key)}: {'true' if value else 'false'}")
	elif isinstance(value, int) and key is not None:
		out.add(f"{_label(key)}: {value}")


def _capped(lines: list[str], focus: str | None) -> dict[str, Any]:
	"""The lines as one text, cut past MAX_REPRESENTATION_BYTES — keeping the
	window that starts at the focus item when there is one."""
	if sum(_size(line) for line in lines) <= MAX_REPRESENTATION_BYTES:
		return {"text": "\n".join(lines), "truncated": False}
	start = 0
	at = _focus_index(lines, focus)
	if at is not None:
		start, lead = at, 0
		while start > 0 and lead + _size(lines[start - 1]) <= FOCUS_LEAD_BYTES:
			start -= 1
			lead += _size(lines[start])
	kept: list[str] = []
	used = 0
	for line in lines[start:]:
		if used + _size(line) > MAX_REPRESENTATION_BYTES:
			break
		kept.append(line)
		used += _size(line)
	return {"text": "\n".join(kept), "truncated": True}


@dataclass(frozen=True)
class AgentReadTarget:
	"""One page the agent reader may load: its intent, the address it is, and
	what that address names."""

	intent: str
	url: str
	post_urn: str | None = None
	comment_urn: str | None = None
	thread_id: str | None = None


def agent_read_target(intent: Any, url: Any, comment_urn: Any) -> AgentReadTarget:
	"""The page a request names, or INVALID_REQUEST. The address must be the
	one page the intent reads — a post, the inbox, one conversation — so a
	request can never send the browser anywhere else."""
	if intent not in AGENT_READ_INTENTS:
		raise SidecarError("INVALID_REQUEST", "intent must be comment_replies, inbox or dm_thread")
	if not isinstance(url, str) or len(url) > 1_000:
		raise SidecarError("INVALID_REQUEST", "url must be a LinkedIn address")
	if intent == "comment_replies":
		post = _POST_URL_RE.fullmatch(url)
		if post is None:
			raise SidecarError("INVALID_REQUEST", "a comment_replies read is of one post's own page")
		if not isinstance(comment_urn, str) or len(comment_urn) > 1_000 or comment_id(comment_urn) is None:
			raise SidecarError("INVALID_REQUEST", "commentUrn is not a recognised LinkedIn comment urn")
		post_urn = post.group(1)
		return AgentReadTarget(intent, f"https://www.linkedin.com/feed/update/{post_urn}/", post_urn, comment_urn)
	if comment_urn is not None:
		raise SidecarError("INVALID_REQUEST", "commentUrn names a comment, and only a post's page has one")
	if intent == "inbox":
		if url.rstrip("/") != INBOX_URL.rstrip("/"):
			raise SidecarError("INVALID_REQUEST", "an inbox read is of the messaging inbox")
		# The inbox is read on the compose view, which opens no conversation.
		return AgentReadTarget(intent, COMPOSE_URL)
	thread = _THREAD_URL_RE.fullmatch(url)
	thread_id = unquote(thread.group(1)) if thread else None
	if thread_id is None or not THREAD_ID_RE.fullmatch(thread_id):
		raise SidecarError("INVALID_REQUEST", "a dm_thread read is of one conversation's own page")
	return AgentReadTarget(intent, f"https://www.linkedin.com/messaging/thread/{thread_id}/", thread_id=thread_id)


def on_post_page(url: str, post_urn: str) -> bool:
	"""Whether the browser settled on the post's own address — the address
	bar's word, which nothing written on the page can change."""
	return unquote(urlparse(url).path).rstrip("/") == f"/feed/update/{post_urn}"
