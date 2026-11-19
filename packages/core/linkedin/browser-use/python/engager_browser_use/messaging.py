"""One conversation, read from its own page's markup — and the unread mark a
read that opened it puts back.

`relationship.py`'s discipline, applied to one thread: the browser hands over
`main` as markup and every rule of the read runs here, over that string, so a
saved page exercises each one (`tests/fixtures/messaging/`). Nothing reads
layout: the sidecar's window is hidden, and markup is the same on screen or
off. The account's conversation LIST is LinkedIn's own JSON, read in
`conversations.py`; this module reads a thread only where the list's last
message is not enough.

READ ONLY, and nothing is typed, focused or scrolled. A thread is the messages
it renders on arrival, and `complete` says whether older ones wait unloaded. A
draft in the composer is someone's unsent words: it is read off the markup and
never touched, and only its hash leaves this module.

Presses, only to put back an unread mark: opening a conversation that showed
unread marks it seen — LinkedIn sends its read receipt, which nothing recalls.
Mark as unread on the conversation still open would be undone by its being
open, so the read moves the page off it by pressing another card that shows
nothing unread (`PRESS_CARD_JS`, accepted only once the list marks that card
the active one, never while a composer is in use), then presses the opened
card's own "Mark as unread", matched by that exact label and nothing else in
its menu, and says whether the card showed unread again.

FAIL CLOSED. Structure this module does not recognise — a message before any
group names its author, an author a two-person thread has no place for, a
composer missing or doubled — is `UI_DRIFT` with the page's fingerprint and a
redacted excerpt, never a best guess. Who someone is comes from a link to
their `/in/` page and nowhere else: a name is only a name, and an id is never
guessed from one. The live page links a member by their member id
(`/in/ACoAA…`, read live 2026-10-20), as LinkedIn's conversation data does:
such a member is named by their member urn, the id's case kept, and by no
profile id — whose public profile it is, only the caller knows — and their
messages by that urn. A time is a `datetime` attribute or unknown, never read
off "8:51 AM" or "Yesterday".

The thread markup is RECONSTRUCTED from the legacy messaging layout
(`msg-s-event-listitem` messages under `msg-s-message-group__meta` author
groups, the `msg-form` composer), not captured: a capture of a real inbox is
real people's messages. The list's cards follow a structure-only probe of the
live list (`tests/fixtures/messaging/inbox_unlinked.html`). UNVERIFIED until
the owner-authorized live read.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import unquote, urlparse

from .profile_data import MEMBER_ID_RE, PROFILE_URN_PREFIX
from .protocol import SELECTOR_PACK_VERSION, SidecarError
from .relationship import MAX_DISPLAY_NAME, MEMBER_URL_PREFIX
from .replies import (
	Element,
	Snapshot,
	clean,
	control_label,
	page_fingerprint,
	parse_markup,
	profile_identity,
	redacted_excerpt,
	text_hash,
)

# Serialises `main` and where the page is — never the body, whose messaging
# overlay holds other conversations, each with a composer of its own.
MESSAGING_SNAPSHOT_JS = r"""() => {
  const root = document.querySelector('main');
  return JSON.stringify({url: location.href, html: root ? root.outerHTML : ''});
}"""

# Presses one card's link and says where the page was when it did, and whether
# the list already marked that card the active one. Refuses first while any
# message composer on the page — beside the list or in the overlay — has focus
# or holds words: a press moves the page off a conversation. Words are
# `textContent`, as the parser reads them, never layout.
PRESS_CARD_JS = r"""(cardId, listClass, cardClass, linkClass, composerSelector, activeClass) => {
  const root = document.querySelector('main');
  if (!root) return JSON.stringify({state: 'missing'});
  const words = element => (element.textContent || '').replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, '').trim();
  const composers = [...document.querySelectorAll(composerSelector)];
  const focused = document.activeElement;
  if (focused && composers.some(box => box === focused || box.contains(focused))) {
    return JSON.stringify({state: 'composer_focused'});
  }
  if (composers.some(box => words(box))) return JSON.stringify({state: 'composer_holds_text'});
  const card = document.getElementById(cardId);
  if (!card || !root.contains(card) || !card.classList.contains(cardClass) || !card.closest('.' + listClass)) {
    return JSON.stringify({state: 'missing'});
  }
  const links = card.querySelectorAll('.' + linkClass);
  if (links.length !== 1) return JSON.stringify({state: 'ambiguous', count: links.length});
  const from = location.href;
  const wasActive = Boolean(card.querySelector('.' + activeClass));
  links[0].click();
  return JSON.stringify({state: 'pressed', from: from, wasActive: wasActive});
}"""

# Where the page is, and which cards the list marks active: how a press is seen
# to have opened its own card's conversation.
LANDED_JS = r"""(listClass, cardClass, activeClass) => {
  const list = document.querySelector('main .' + listClass);
  const active = list
    ? [...list.children].filter(item => item.classList.contains(cardClass) && item.querySelector('.' + activeClass))
    : [];
  return JSON.stringify({url: location.href, active: active.map(item => item.id)});
}"""

# Opens one card's own overflow menu: its one control, and nothing in the menu.
OPEN_CARD_MENU_JS = r"""(cardId, listClass, cardClass, controlClass) => {
  const card = document.getElementById(cardId);
  if (!card || !card.classList.contains(cardClass) || !card.closest('main .' + listClass)) {
    return JSON.stringify({state: 'missing'});
  }
  const controls = card.querySelectorAll('button.' + controlClass);
  if (controls.length !== 1) return JSON.stringify({state: 'ambiguous', count: controls.length});
  controls[0].click();
  return JSON.stringify({state: 'opened'});
}"""

# Presses the one item in a card's open menu whose accessible label is exactly
# `label` — its aria-label, else its words. The menu sits beside Archive,
# Delete and Report: nothing else is ever pressed, and two items answering to
# the label press neither.
MARK_UNREAD_JS = r"""(cardId, cardClass, controlClass, label) => {
  const card = document.getElementById(cardId);
  if (!card || !card.classList.contains(cardClass)) return JSON.stringify({state: 'missing'});
  const clean = value => (value || '').replace(/\s+/g, ' ').trim();
  const labelOf = element => clean(element.getAttribute('aria-label')) || clean(element.textContent);
  const items = [...card.querySelectorAll('[role="menuitem"], [role="button"], button, .artdeco-dropdown__item')]
    .filter(element => !element.classList.contains(controlClass) && labelOf(element) === label);
  const innermost = items.filter(element => !items.some(other => other !== element && element.contains(other)));
  if (!innermost.length) return JSON.stringify({state: 'none'});
  if (innermost.length !== 1) return JSON.stringify({state: 'ambiguous', count: innermost.length});
  innermost[0].click();
  return JSON.stringify({state: 'pressed'});
}"""

# A thread id as the wire carries it: what LinkedIn mints, and nothing a path
# could misread.
THREAD_ID_RE = re.compile(r"[A-Za-z0-9_=+\-]{1,200}")
_THREAD_PATH_RE = re.compile(r"^/messaging/thread/([^/]+)/?$")
# The compose view's segment: the messaging page with no conversation open.
COMPOSE_SEGMENT = "new"

CONVERSATION_LIST_CLASS = "msg-conversations-container__conversations-list"
CARD_CLASS = "msg-conversation-listitem"
# The element a card is pressed by: an `<a>` to its thread on the legacy page,
# a `<div>` with a click handler on the live one.
CARD_LINK_CLASS = "msg-conversation-listitem__link"
# Either marks a card unread: the card's own unread modifier, or the count badge
# shown on it.
UNREAD_CLASSES = ("msg-conversation-card__convo-item-container--unread", "notification-badge--show")
FACEPILE_CLASS = "msg-facepile-grid"
# What the list puts inside the card whose conversation is open (read live
# 2026-10-12, on the first card).
ACTIVE_CARD_CLASS = "msg-conversation-listitem__active-text"
# A card's overflow menu, and the one item a read presses in it.
CARD_MENU_CONTROL_CLASS = "msg-thread-actions__control"
MARK_UNREAD_LABEL = "Mark as unread"

THREAD_CLASS = "msg-thread"
HEADER_CLASS = "msg-title-bar"
HEADER_TITLE_CLASS = "msg-entity-lockup__entity-title"
# What the page tells a screen reader alone — a member's presence, "Status is
# offline" — inside the header link that names them.
VISUALLY_HIDDEN_CLASS = "visually-hidden"
MESSAGE_LIST_CLASS = "msg-s-message-list"
MESSAGE_CLASS = "msg-s-event-listitem"
MESSAGE_BODY_CLASS = "msg-s-event-listitem__body"
GROUP_META_CLASS = "msg-s-message-group__meta"
GROUP_NAME_CLASS = "msg-s-message-group__name"
HISTORY_LOADER_CLASS = "msg-s-message-list__loader"
# The member card LinkedIn renders above a conversation's first message: the
# one sign the whole history is loaded.
CONVERSATION_START_CLASS = "msg-s-profile-card"
COMPOSER_CLASS = "msg-form__contenteditable"
PLACEHOLDER_CLASS = "msg-form__placeholder"
# Every box a message is written in, anywhere on the page, as a press checks
# them.
COMPOSER_SELECTOR = f".{COMPOSER_CLASS}, .msg-form [contenteditable], .msg-form textarea"
_PARTICIPANT_COUNT_RE = re.compile(r"\d[\d,]*\s+(?:participants|members|people)", re.IGNORECASE)
_OLDER_MESSAGES_RE = re.compile(
	r"\b(?:load|show|see|view)\b.*\b(?:previous|older|earlier)\b.*\bmessages?\b", re.IGNORECASE
)
# What stands between names in a list of them: commas, an ampersand, "and".
_NAME_SEPARATORS_RE = re.compile(r"^[\s,;&]*(?:and(?:\s+|$))?|[\s,;&]+$")
# An editor pads an empty line with these; they are nobody's words.
_ZERO_WIDTH_RE = re.compile(r"[\u200b\u200c\u200d\u2060\ufeff]")
# The one segment of a member's address that names them, as minted.
_MEMBER_PATH_RE = re.compile(r"^/in/([^/]+)")
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def messaging_snapshot_from_page(raw: Any) -> Snapshot:
	"""What MESSAGING_SNAPSHOT_JS returned, or drift when it is not that shape."""
	if not isinstance(raw, dict) or not isinstance(raw.get("url"), str) or not isinstance(raw.get("html"), str):
		raise SidecarError("UI_DRIFT", "the messaging page could not be serialised for reading")
	return Snapshot(url=raw["url"], root=parse_markup(raw["html"]))


def thread_id_of(href: str | None) -> str | None:
	"""The thread a messaging address opens, percent-decoded; None for any other
	address — the compose view's among them, which opens none."""
	if not href:
		return None
	parsed = urlparse(href)
	if parsed.netloc and parsed.netloc not in {"www.linkedin.com", "linkedin.com"}:
		return None
	match = _THREAD_PATH_RE.match(parsed.path)
	thread_id = unquote(match.group(1)) if match else None
	return None if thread_id == COMPOSE_SEGMENT else thread_id


def press_card_args(card: str) -> tuple[str, ...]:
	"""PRESS_CARD_JS's arguments for the card the page knows by the id `card`."""
	return (card, CONVERSATION_LIST_CLASS, CARD_CLASS, CARD_LINK_CLASS, COMPOSER_SELECTOR, ACTIVE_CARD_CLASS)


def landed_args() -> tuple[str, ...]:
	return (CONVERSATION_LIST_CLASS, CARD_CLASS, ACTIVE_CARD_CLASS)


def card_menu_args(card: str) -> tuple[str, ...]:
	return (card, CONVERSATION_LIST_CLASS, CARD_CLASS, CARD_MENU_CONTROL_CLASS)


def mark_unread_args(card: str) -> tuple[str, ...]:
	return (card, CARD_CLASS, CARD_MENU_CONTROL_CLASS, MARK_UNREAD_LABEL)


def press_landed(raw: Any, card: str, *, before: str | None, was_active: bool) -> str | None:
	"""The thread a card's press opened, as LANDED_JS read the page: the address
	names a thread, the list marks that card and no other active, and — unless
	the card was already the open one — the address moved off where it was.
	None until all three hold; the address alone never attests a card."""
	if not isinstance(raw, dict) or not isinstance(raw.get("url"), str) or raw.get("active") != [card]:
		return None
	thread_id = thread_id_of(raw["url"])
	if thread_id is None or (not was_active and thread_id == before):
		return None
	return thread_id


def card_shows_unread(snapshot: Snapshot, card: str) -> bool:
	"""Whether the list's card with the id `card` carries an unread mark."""
	return any(
		item.get("id") == card and any(_classed(item, name) for name in UNREAD_CLASSES)
		for conversations in _classed(snapshot.root, CONVERSATION_LIST_CLASS)
		for item in _items(conversations)
	)


def inbox_rendered(snapshot: Snapshot) -> bool:
	"""Whether the conversation list holds a card yet: until it does, an empty
	list is a list still loading."""
	return any(
		item.has_class(CARD_CLASS)
		for conversations in _classed(snapshot.root, CONVERSATION_LIST_CLASS)
		for item in _items(conversations)
	)


@dataclass(frozen=True)
class UnreadRestore:
	"""What putting back an opened conversation's unread mark presses, by the
	id the page knows each card by: `card`, the conversation's own, the one
	the list marks active; `movers`, the cards that show nothing unread, one of
	which is pressed first to move the page off it."""

	card: str
	movers: tuple[str, ...]
	cards: Mapping[str, Element]
	fingerprint: str

	def drift(self, card: str, message: str) -> SidecarError:
		return _drift(message, self.cards[card], self.fingerprint)


def unread_restore(snapshot: Snapshot, landed: Any, thread_id: str) -> UnreadRestore | None:
	"""The presses that put back the unread mark of the conversation open on
	the page, as LANDED_JS read it — or None where the address is not that
	conversation's, or the list marks not exactly one card active: a card the
	page does not single out is never pressed."""
	if (
		not isinstance(landed, dict)
		or not isinstance(landed.get("url"), str)
		or thread_id_of(landed["url"]) != thread_id
		or not isinstance(landed.get("active"), list)
		or len(landed["active"]) != 1
	):
		return None
	cards = {
		item.get("id"): item
		for conversations in _classed(snapshot.root, CONVERSATION_LIST_CLASS)
		for item in _items(conversations)
		if item.has_class(CARD_CLASS) and item.get("id") and not _unrendered(item)
	}
	card = landed["active"][0]
	if card not in cards:
		return None
	movers = tuple(
		other
		for other, item in cards.items()
		if other != card
		and not any(_classed(item, name) for name in UNREAD_CLASSES)
		and len(_classed(item, CARD_LINK_CLASS)) == 1
	)
	return UnreadRestore(card=card, movers=movers, cards=cards, fingerprint=page_fingerprint(snapshot.root))


def thread_page(snapshot: Snapshot, thread_id: str) -> None:
	"""Refuses a page that is not the thread asked for — the address bar's
	answer, which nothing written on the page can change. LinkedIn sends a
	thread that is gone, or not this account's, to the inbox: no retry brings
	it back."""
	if thread_id_of(snapshot.url) != thread_id:
		raise SidecarError("THREAD_UNAVAILABLE", "the conversation did not load as the thread asked for")


def thread_rendered(snapshot: Snapshot) -> bool:
	"""Whether the thread's header, a message and its composer are all in the
	markup: a read before the composer renders cannot say whether a draft is
	waiting."""
	return all(_classed(snapshot.root, name) for name in (HEADER_CLASS, MESSAGE_CLASS, COMPOSER_CLASS))


def dm_thread_read(
	snapshot: Snapshot,
	*,
	thread_id: str,
	own_profile_id: str,
	own_display_name: str | None,
	since_ms: int | None,
	observed_at: int,
	session_id: str,
	own_member_urn: str | None = None,
) -> dict[str, Any]:
	"""The wire result for one settled snapshot of a thread, or the failure that
	keeps the caller from changing anything. `own_member_urn`, where the
	account's is known, is the account too when a link names it."""
	fingerprint = page_fingerprint(snapshot.root)
	thread_page(snapshot, thread_id)
	thread = _one(snapshot.root, THREAD_CLASS, "conversation threads", fingerprint)
	header = _one(thread, HEADER_CLASS, "thread headers", fingerprint)
	own = _Identity(own_profile_id, own_profile_id, f"{MEMBER_URL_PREFIX}{own_profile_id}/", None)
	members, names, group = _header(header, own, own_member_urn, fingerprint)
	# Two people talk in a thread that is not a group's: a third author is a
	# page that contradicts its own header.
	parties = None if group else {own.key, next(iter(members)).key}
	messages, authors = _messages(thread, own, own_member_urn, parties, observed_at, fingerprint)
	own_name = next((author.name for author in authors if author.identity == own), own_display_name)
	people = [(own, own_name or "", True), *((member, name, False) for member, name in members.items())]
	listed = {identity.key for identity, _, _ in people}
	people += [(author.identity, author.name, False) for author in authors if author.identity.key not in listed]
	participants = [_participant(identity, name, is_self=is_self) for identity, name, is_self in people]
	# A name the header gives without a link is listed only where nobody already
	# listed bears it: it gives no one an id, and keeps one person from being
	# listed twice.
	for name in names:
		if all(participant["displayName"] != name for participant in participants):
			participants.append(_participant(None, name, is_self=False))
	# A read is complete only where it reached what was asked for: a message
	# loaded from before `since`, or the conversation's own start. A list that
	# merely shows no loader has not said nothing waits above it.
	reaches_since = since_ms is not None and any(
		message["sentAt"] is not None and message["sentAt"] < since_ms for message in messages
	)
	return {
		"threadId": thread_id,
		"participants": participants,
		"group": group,
		"messages": [
			message
			for message in messages
			if since_ms is None or message["sentAt"] is None or message["sentAt"] >= since_ms
		],
		"complete": reaches_since or (_starts_loaded(thread) and not _older_unloaded(thread)),
		"composer": _composer(thread, fingerprint),
		"observedAt": observed_at,
		"sessionId": session_id,
		"pageFingerprint": fingerprint,
		"selectorPack": SELECTOR_PACK_VERSION,
	}


def _header(
	header: Element, own: _Identity, own_member_urn: str | None, fingerprint: str
) -> tuple[dict[_Identity, str], list[str], bool]:
	"""(the members the header links, each with the name it shows them by, the
	names a group's header gives, whether the thread is a group's). A header
	that links one member and shows no sign of a group — a second member, a
	facepile, a participant count, a title naming more than one person — is a
	two-person thread with that member. A header that links no one leaves who
	the thread is with unverified, unless it is a group's and names them."""
	linked: dict[_Identity, str] = {}
	for element in header.iter():
		identity = _member(element, own, own_member_urn)
		if identity is None or identity == own:
			continue
		linked[identity] = linked.get(identity) or _link_name(element)[:MAX_DISPLAY_NAME]
	if not all(linked.values()):
		raise _drift("the header links a member it does not name", header, fingerprint)
	names = [name for title in _classed(header, HEADER_TITLE_CLASS) for name in _names(title)]
	group = (
		len(linked) > 1
		or len(names) > 1
		or bool(_classed(header, FACEPILE_CLASS))
		or any(_PARTICIPANT_COUNT_RE.fullmatch(element.words()) for element in header.iter())
	)
	if not linked and not (group and names):
		raise _drift("the header links no member: who the thread is with cannot be verified", header, fingerprint)
	return linked, names if group else [], group


def _link_name(link: Element) -> str:
	"""The name a header link shows its member by. The live header's link
	holds the name, then the presence the page tells a screen reader ("Status
	is offline") and the member's headline — all three, a read of 2026-10-20
	kept as one name: the name is the title it holds, else its first words a
	reader sees; a link with no words, its label."""
	titles = [title.text() for title in _classed(link, HEADER_TITLE_CLASS)]
	if len(titles) == 1 and titles[0]:
		return titles[0]
	hidden = {run for element in _classed(link, VISUALLY_HIDDEN_CLASS) for run in element.runs()}
	shown = [run for run in link.runs() if run not in hidden]
	return shown[0] if shown else clean(link.get("aria-label") or "")


@dataclass(frozen=True)
class _Identity:
	"""Who a link to a member's own page names: their public profile, or — on
	a page that links them by member id — their member urn alone. `key` is
	what the read names them by: the profile id, else the urn."""

	key: str
	profile_id: str | None
	profile_url: str | None
	member_urn: str | None


@dataclass(frozen=True)
class _Author:
	identity: _Identity
	name: str


def _messages(
	thread: Element,
	own: _Identity,
	own_member_urn: str | None,
	parties: set[str] | None,
	observed_at: int,
	fingerprint: str,
) -> tuple[list[dict[str, Any]], list[_Author]]:
	"""Every message the thread renders, oldest first, and their authors in the
	order they first wrote. A group's meta names its author once, above the
	first of their consecutive messages; the rest carry none and are theirs."""
	message_list = _one(thread, MESSAGE_LIST_CLASS, "message lists", fingerprint)
	events = _classed(message_list, MESSAGE_CLASS)
	if not events:
		raise _drift("the thread shows no messages", message_list, fingerprint)
	# An author or words outside every message belong to a layout this module
	# does not know, and would otherwise vanish from the read.
	for name in (GROUP_META_CLASS, MESSAGE_BODY_CLASS):
		for element in _classed(message_list, name):
			if not any(event.contains(element) for event in events):
				raise _drift("an author or a body sits outside every message", element, fingerprint)
	messages: list[dict[str, Any]] = []
	authors: dict[str, _Author] = {}
	seen: set[str] = set()
	author: _Author | None = None
	for event in events:
		message_id = event.get("data-event-urn")
		if not message_id:
			raise _drift("a message carries no id", event, fingerprint)
		if message_id in seen:
			raise _drift("two messages carry one id", event, fingerprint)
		seen.add(message_id)
		metas = _classed(event, GROUP_META_CLASS)
		if len(metas) > 1:
			raise _drift(f"a message carries {len(metas)} author groups", event, fingerprint)
		if metas:
			author = _group_author(metas[0], own, own_member_urn, fingerprint)
		if author is None:
			raise _drift("a message comes before any group names its author", event, fingerprint)
		if parties is not None and author.identity.key not in parties:
			raise _drift("a message's author is neither party to the conversation", event, fingerprint)
		authors.setdefault(author.identity.key, author)
		bodies = _classed(event, MESSAGE_BODY_CLASS)
		if len(bodies) > 1:
			raise _drift(f"a message has {len(bodies)} bodies", event, fingerprint)
		body = bodies[0] if bodies else None
		# An attachment sent alone has no body, and says nothing.
		text = body.text() if body is not None else ""
		messages.append(
			{
				"messageId": message_id,
				"fromSelf": author.identity == own,
				"authorProfileId": author.identity.key,
				"text": text,
				"textHash": text_hash(text),
				"sentAt": _sent_at(event, body, fingerprint),
				"observedAt": observed_at,
			}
		)
	return messages, list(authors.values())


def _group_author(meta: Element, own: _Identity, own_member_urn: str | None, fingerprint: str) -> _Author:
	"""The one member a group's meta links, under the one name it shows."""
	identities = {
		identity for identity in (_member(element, own, own_member_urn) for element in meta.iter()) if identity is not None
	}
	names = [name.text() for name in _classed(meta, GROUP_NAME_CLASS)]
	if len(identities) != 1 or len(names) != 1 or not names[0]:
		raise _drift(f"a message group links {len(identities)} authors under {len(names)} names", meta, fingerprint)
	return _Author(next(iter(identities)), names[0][:MAX_DISPLAY_NAME])


def _starts_loaded(thread: Element) -> bool:
	"""Whether the thread shows the card that heads a conversation's first
	message, so nothing older waits above what loaded."""
	return bool(_classed(thread, CONVERSATION_START_CLASS))


def _older_unloaded(thread: Element) -> bool:
	"""Whether the thread shows history it has not loaded: its loader, or a
	control that loads earlier messages."""
	return bool(_classed(thread, HISTORY_LOADER_CLASS)) or any(
		element.tag == "button" and _OLDER_MESSAGES_RE.search(control_label(element)) for element in thread.iter()
	)


def _composer(thread: Element, fingerprint: str) -> dict[str, Any]:
	"""Whether words wait unsent in the thread's one composer, and their hash.
	Its placeholder renders beside the box, so the box holds only what someone
	wrote."""
	boxes = _classed(thread, COMPOSER_CLASS)
	if len(boxes) != 1:
		raise _drift(
			f"the thread shows {len(boxes)} composers: whether a draft is waiting cannot be told", thread, fingerprint
		)
	if _classed(boxes[0], PLACEHOLDER_CLASS):
		raise _drift("the composer holds its placeholder: a draft cannot be told from it", boxes[0], fingerprint)
	draft = clean(_ZERO_WIDTH_RE.sub("", boxes[0].text()))
	return {"hasDraft": True, "draftHash": text_hash(draft)} if draft else {"hasDraft": False}


def _sent_at(scope: Element, words: Element | None, fingerprint: str) -> int | None:
	"""The instant the scope's time elements carry, outside `words` — someone's
	message, which can hold anything. None when none carries one."""
	instants = {
		instant
		for instant in (
			_instant(element.get("datetime"))
			for element in scope.iter()
			if element.tag == "time" and (words is None or not words.contains(element))
		)
		if instant is not None
	}
	if len(instants) > 1:
		raise _drift(f"one message shows {len(instants)} times", scope, fingerprint)
	return next(iter(instants), None)


def _instant(value: str | None) -> int | None:
	"""Epoch ms of an ISO 8601 instant. A date, or a time with no offset, is not
	one: what this module cannot place exactly is unknown."""
	try:
		moment = datetime.fromisoformat(value or "")
	except ValueError:
		return None
	if moment.tzinfo is None:
		return None
	return (moment - _EPOCH) // timedelta(milliseconds=1)


def _names(element: Element) -> list[str]:
	"""The names an element lists, one to a run of text, with what stands
	between them dropped. A name is never cut out of a run: "Jane Doe, MBA" is
	one person."""
	names = (_NAME_SEPARATORS_RE.sub("", run) for run in element.runs())
	return [name[:MAX_DISPLAY_NAME] for name in names if name]


def _member(element: Element, own: _Identity, own_member_urn: str | None) -> _Identity | None:
	"""Who a link to a member's own page names: the member by the profile its
	address names, or — an address that is LinkedIn's own `/in/<member id>/`
	— by their member urn, its id's case kept, and no profile. A link to the
	account, either way, is the account."""
	if element.tag != "a":
		return None
	href = element.get("href")
	identity = profile_identity(href)
	if identity is None or not identity[1].startswith(MEMBER_URL_PREFIX):
		return None
	path = _MEMBER_PATH_RE.match(urlparse(href or "").path)
	member_id = unquote(path.group(1)) if path else None
	if member_id is None or not MEMBER_ID_RE.fullmatch(member_id):
		return own if identity[0] == own.key else _Identity(identity[0], identity[0], identity[1], None)
	member_urn = f"{PROFILE_URN_PREFIX}{member_id}"
	return own if member_urn == own_member_urn else _Identity(member_urn, None, None, member_urn)


def _participant(identity: _Identity | None, name: str, *, is_self: bool) -> dict[str, Any]:
	participant = {
		"profileId": identity.profile_id if identity else None,
		"profileUrl": identity.profile_url if identity else None,
		"displayName": name,
		"isSelf": is_self,
	}
	if identity is None or identity.member_urn is None:
		return participant
	return {**participant, "memberUrn": identity.member_urn}


def _classed(scope: Element, name: str) -> list[Element]:
	return [element for element in scope.iter() if element.has_class(name)]


def _items(element: Element) -> list[Element]:
	return [child for child in element.children if isinstance(child, Element)]


def _unrendered(item: Element) -> bool:
	"""A list row with no elements and no words in it: a placeholder still
	waiting for its card."""
	return not any(
		isinstance(child, Element) or child.strip() for child in item.children
	)


def _one(scope: Element, name: str, what: str, fingerprint: str) -> Element:
	found = _classed(scope, name)
	if len(found) != 1:
		raise _drift(f"{len(found)} {what} where one belongs", scope, fingerprint)
	return found[0]


def _drift(message: str, at: Element, fingerprint: str) -> SidecarError:
	return SidecarError(
		"UI_DRIFT",
		f"the messaging page's structure was not recognised: {message}",
		detail={"pageFingerprint": fingerprint, "selectorPack": SELECTOR_PACK_VERSION, "excerpt": redacted_excerpt(at)},
	)
