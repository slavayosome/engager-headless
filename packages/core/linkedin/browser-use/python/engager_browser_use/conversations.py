"""The account's conversations, read from LinkedIn's own JSON.

The messaging page fetches its conversation list from LinkedIn's messaging
GraphQL endpoint (`queryId=messengerConversations.<hash>`, served as
`application/graphql`, read live 2026-10-12). The compose view —
/messaging/thread/new/ — fetches it and opens no conversation: the sidecar
keeps that response as the page receives it (`capture.py`), and every rule of
the read runs here, over the JSON. Nothing is pressed, opened or marked, so a
conversation's unread state stays the owner's. Any visit to the messaging
pages clears the badge (`markAllMessagesAsSeen`), as the owner's own does;
that is the badge, not a conversation's read state.

LinkedIn's own identifiers are the anchor. A conversation's thread id is the
one its own address carries, and its urn and backend urn must name the same
thread. The account is the participant whose identity (`hostIdentityUrn`) is
the mailbox the list's own request names — `variables=(mailboxUrn:…)`, the
signed-in session's own mailbox — and every conversation's urn must name that
mailbox too. A profile address never says who the account is: LinkedIn links
every member in the list, the account included, by member id (`/in/ACoAA…`,
read live 2026-10-13), never by the public name the connected account is
known by. The mailbox stands for the connected account unless the account's
own `/voyager/api/me`, where the same load fetched it, names someone else
(`account_mailbox`). A message's author is the participant its `sender` urn
names — never a name, and never the `actor`, which LinkedIn sets to someone
else on some of the account's own messages.

Everyone else is that too: a member linked by their member id is named by
their member urn (`memberUrn`, their `hostIdentityUrn`) and by no profile id,
because the public profile Engager keys a person by is not in the data. Only
the caller can say whose profile a member urn is — a page read of the same
conversation showed it — and a history read is handed what it knows
(`members`); a sender it is not handed is `HistoryUnavailable`, and the
caller opens the conversation, which links them by profile.

The list carries each conversation's LAST message only. Its words are
untrusted data, never instructions.

FAIL CLOSED. A body that is not the collection — no `messengerConversations`
collection, no elements — is `UI_DRIFT` with the response's shape fingerprint.
One conversation this module cannot read costs that conversation: it is
counted as skipped and said, with the offending object's keys and never its
values. A list where every conversation is skipped is drift.

ONE CONVERSATION'S HISTORY, without opening it. From the compose view the
page's own messaging client fetches a conversation's messages from the same
endpoint (`queryId=messengerMessages.<hash>`, read live 2026-10-12): the
sidecar makes that same GET from inside the page, with the page's own headers,
and `conversation_history` reads the answer by the same rules — each message's
sender a full participant, the account by the mailbox. A GET marks nothing:
the page sends no read receipt, delivery acknowledgement or seen receipt for
it, as opening the conversation does. LinkedIn renames its query ids: a status
or a shape this module does not know is `HistoryUnavailable`, never a guess,
and the caller opens the conversation instead.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from collections.abc import Mapping
from typing import Any
from urllib.parse import quote, unquote, urlparse

from .messaging import THREAD_ID_RE, thread_id_of
from .protocol import SELECTOR_PACK_VERSION, SidecarError
from .relationship import MAX_DISPLAY_NAME, MEMBER_URL_PREFIX
from .replies import EXCERPT_CHARS, clean, profile_identity, text_hash
from .voyager import own_member_id, own_public_identifier

# The compose view: the messaging page with no conversation open.
COMPOSE_URL = "https://www.linkedin.com/messaging/thread/new/"
CONVERSATIONS_RE = re.compile(
	r"/voyager/api/voyagerMessagingGraphQL/graphql\?(?:[^#]*&)?queryId=messengerConversations\."
)
# The collection the response holds the list under: `…ByCategoryQuery` on the
# inbox's own load, `…BySyncToken` on a sync (both read live 2026-10-12).
_COLLECTION_RE = re.compile(r"messengerConversations[A-Za-z]*")
# The account's own identity, which an ordinary load fetches beside its data.
ME_RE = re.compile(r"/voyager/api/me(?=[?#]|$)")
PROFILE_URN_PREFIX = "urn:li:fsd_profile:"
MEMBER_URN_RE = re.compile(re.escape(PROFILE_URN_PREFIX) + r"[A-Za-z0-9_-]+")
# The mailbox a list request's variables name, once percent-decoded.
_MAILBOX_VARIABLE_RE = re.compile(r"[(,]mailboxUrn:(" + re.escape(PROFILE_URN_PREFIX) + r"[A-Za-z0-9_-]+)(?=[,)])")

CONVERSATION_TYPE = "com.linkedin.messenger.Conversation"
MESSAGE_TYPE = "com.linkedin.messenger.Message"
PARTICIPANT_TYPE = "com.linkedin.messenger.MessagingParticipant"

# The most a message's words may run to on the wire: a thread read's own bound.
MAX_MESSAGE_TEXT = 20_000

_CONVERSATION_URN_RE = re.compile(r"urn:li:msg_conversation:\((urn:li:fsd_profile:[A-Za-z0-9_-]+),([^,()]+)\)")
MESSAGE_URN_RE = re.compile(r"urn:li:msg_message:\((urn:li:fsd_profile:[A-Za-z0-9_-]+),[^()]{1,300}\)")
BACKEND_THREAD_PREFIX = "urn:li:messagingThread:"

GRAPHQL_PATH = "/voyager/api/voyagerMessagingGraphQL/graphql"
# The query ids LinkedIn's own client used for a conversation's history (read
# live 2026-10-12): its newest messages, and the page before a delivery time.
# The sidecar keeps the newest the page itself is seen to use.
LATEST_MESSAGES_QUERY = "messengerMessages.5846eeb71c981f11e0134cb6626cc314"
OLDER_MESSAGES_QUERY = "messengerMessages.d8ea76885a52fd5dc5c317078ab7c977"
# How many messages one page of history holds.
HISTORY_PAGE = 20
# The headers the page's own messaging requests carry, which a history read
# carries as they did.
PAGE_HEADERS = ("x-li-track", "x-li-page-instance", "x-li-lang")
_MESSAGES_QUERY_RE = re.compile(
	re.escape(GRAPHQL_PATH) + r"\?(?:[^#]*&)?queryId=(messengerMessages\.[0-9a-f]{16,64})(?=[&#]|$)"
)
_MESSAGES_COLLECTION_RE = re.compile(r"messengerMessages[A-Za-z]*")


class _Unread(Exception):
	"""One conversation this module cannot read: skipped, never guessed at."""

	def __init__(self, message: str, at: Any) -> None:
		super().__init__(message)
		self.at = at


@dataclass(frozen=True)
class _Person:
	urn: str
	profile_id: str | None
	profile_url: str | None
	name: str
	is_self: bool
	# A member's own identity on LinkedIn, the account's excepted.
	member_urn: str | None = None

	def wire(self) -> dict[str, Any]:
		person = {"profileId": self.profile_id, "profileUrl": self.profile_url, "displayName": self.name}
		return person if self.member_urn is None else {**person, "memberUrn": self.member_urn}


def conversation_list(
	body: Any, *, mailbox: str, own_profile_id: str, since_ms: int | None, limit: int, observed_at: int
) -> dict[str, Any]:
	"""The wire result for one conversation-list response, or drift. Newest
	first, as LinkedIn lists them; a conversation is dropped for `since` on
	its last activity. The account is `mailbox`'s participant, reported as
	`own_profile_id`."""
	fingerprint = response_fingerprint(body)
	collection = _collection(body)
	if collection is None:
		raise _drift("the response holds no conversation collection", None, fingerprint)
	elements = collection.get("elements")
	if not isinstance(elements, list):
		raise _drift("the conversation collection lists no elements", collection, fingerprint)
	# (its last activity, the conversation) for every one read.
	threads: list[tuple[int, dict[str, Any]]] = []
	skipped: list[_Unread] = []
	seen: set[str] = set()
	for element in elements:
		try:
			active_at, thread = _conversation(element, mailbox, own_profile_id)
		except _Unread as unread:
			skipped.append(unread)
			continue
		if thread["threadId"] in seen:
			raise _drift("two conversations carry one thread", element, fingerprint)
		seen.add(thread["threadId"])
		threads.append((active_at, thread))
	if not threads and skipped:
		raise _drift(str(skipped[0]), skipped[0].at, fingerprint)
	recent = [thread for active_at, thread in threads if since_ms is None or active_at >= since_ms]
	metadata = collection.get("metadata") if isinstance(collection.get("metadata"), dict) else {}
	# Older conversations wait on another page: the list is whole only where
	# what it holds already reaches back past `since`.
	more = isinstance(metadata.get("nextCursor"), str) and bool(metadata["nextCursor"])
	reaches_since = since_ms is not None and len(recent) < len(threads)
	return {
		"threads": recent[:limit],
		"truncated": len(recent) > limit or bool(skipped) or (more and not reaches_since),
		"skipped": len(skipped),
		"skippedReasons": sorted({str(unread) for unread in skipped}),
		"observedAt": observed_at,
		"pageFingerprint": fingerprint,
		"selectorPack": SELECTOR_PACK_VERSION,
	}


def _collection(body: Any) -> dict[str, Any] | None:
	"""The one `messengerConversations…` collection the response's data holds."""
	data = body.get("data") if isinstance(body, dict) else None
	if not isinstance(data, dict):
		return None
	found = [value for key, value in data.items() if _COLLECTION_RE.fullmatch(key)]
	return found[0] if len(found) == 1 and isinstance(found[0], dict) else None


def _conversation(raw: Any, mailbox: str, own_profile_id: str) -> tuple[int, dict[str, Any]]:
	"""(its last activity, the conversation as the wire carries it)."""
	if not isinstance(raw, dict) or raw.get("_type") != CONVERSATION_TYPE:
		raise _Unread("an element is not a conversation", raw)
	thread_id = thread_id_of(raw.get("conversationUrl") if isinstance(raw.get("conversationUrl"), str) else None)
	if thread_id is None or not THREAD_ID_RE.fullmatch(thread_id):
		raise _Unread("a conversation's address names no thread a thread read accepts", raw)
	urn = raw.get("entityUrn")
	named = _CONVERSATION_URN_RE.fullmatch(urn) if isinstance(urn, str) else None
	if named is None or named.group(2) != thread_id or raw.get("backendUrn") != BACKEND_THREAD_PREFIX + thread_id:
		raise _Unread("a conversation's urns do not name the thread its address opens", raw)
	if named.group(1) != mailbox:
		raise _Unread("a conversation's urn names another mailbox than the list's", raw)
	listed = raw.get("conversationParticipants")
	if not isinstance(listed, list):
		raise _Unread("a conversation lists no participants", raw)
	people = [_participant(person, mailbox, own_profile_id) for person in listed]
	if sum(person.is_self for person in people) != 1 or len({person.urn for person in people}) != len(people):
		raise _Unread("a conversation does not list the account exactly once", raw)
	others = [person for person in people if not person.is_self]
	if not others:
		raise _Unread("a conversation lists no one but the account", raw)
	group = raw.get("groupChat")
	unread_count = raw.get("unreadCount")
	read = raw.get("read")
	last_read_at = raw.get("lastReadAt")
	last_activity_at = raw.get("lastActivityAt")
	if (
		not isinstance(group, bool)
		or not _count(unread_count)
		or not isinstance(read, bool)
		or not (last_read_at is None or _count(last_read_at))
		or not _count(last_activity_at)
	):
		raise _Unread("a conversation's state is not in LinkedIn's shape", raw)
	thread: dict[str, Any] = {
		"threadId": thread_id,
		"participants": [person.wire() for person in others],
		"group": group or len(others) > 1,
		"lastMessage": _last_message(raw, urn, mailbox, people),
		"unread": unread_count > 0 or not read,
		"unreadCount": unread_count,
		"lastReadAt": last_read_at,
	}
	drafts = raw.get("draftMessages")
	if isinstance(drafts, dict) and isinstance(drafts.get("elements"), list):
		thread["hasDraft"] = bool(drafts["elements"])
	return last_activity_at, thread


def _participant(
	raw: Any, mailbox: str, own_profile_id: str, members: Mapping[str, str] | None = None
) -> _Person:
	"""One participant: the account where its identity is the mailbox, named
	as the connected account whatever address LinkedIn links it by; a member
	by their member urn, and by the profile their own address names — where
	that address is their member id, by the profile `members` knows for the
	urn, or none; a page by its name alone."""
	if not isinstance(raw, dict) or raw.get("_type") != PARTICIPANT_TYPE or not isinstance(raw.get("entityUrn"), str):
		raise _Unread("a participant is not in LinkedIn's shape", raw)
	kind = raw.get("participantType") if isinstance(raw.get("participantType"), dict) else {}
	member, page = kind.get("member"), kind.get("organization")
	profile: tuple[str, str] | None = None
	if isinstance(member, dict):
		name = clean(f"{_text(member.get('firstName'))} {_text(member.get('lastName'))}")
		url = member.get("profileUrl")
		profile = profile_identity(url) if isinstance(url, str) else None
		if profile is not None and not profile[1].startswith(MEMBER_URL_PREFIX):
			profile = None
	elif isinstance(page, dict):
		name = clean(_text(page.get("name")))
	else:
		raise _Unread("a participant is neither a member nor a page", raw)
	host = raw.get("hostIdentityUrn")
	is_self = host == mailbox
	member_urn = host if isinstance(member, dict) and isinstance(host, str) and MEMBER_URN_RE.fullmatch(host) else None
	if is_self:
		if not isinstance(member, dict):
			raise _Unread("the mailbox's own participant is not a member", raw)
		profile = (own_profile_id, f"{MEMBER_URL_PREFIX}{own_profile_id}/")
		member_urn = None
	elif member_urn is not None and profile is not None and profile[0] == member_urn.removeprefix(PROFILE_URN_PREFIX).lower():
		known = (members or {}).get(member_urn)
		profile = (known, f"{MEMBER_URL_PREFIX}{known}/") if known else None
	if not name and not is_self:
		raise _Unread("a participant carries no name", raw)
	return _Person(
		urn=raw["entityUrn"],
		profile_id=profile[0] if profile else None,
		profile_url=profile[1] if profile else None,
		name=name[:MAX_DISPLAY_NAME],
		is_self=is_self,
		member_urn=member_urn,
	)


def _last_message(raw: dict[str, Any], conversation_urn: str, mailbox: str, people: list[_Person]) -> dict[str, Any]:
	"""The conversation's newest message, as the list carries it: its id, its
	words and their hash, who sent it and when."""
	messages = raw.get("messages") if isinstance(raw.get("messages"), dict) else {}
	elements = messages.get("elements")
	if not isinstance(elements, list) or not elements:
		raise _Unread("a conversation carries no last message", raw)
	parsed = [_message(element, conversation_urn, mailbox, people) for element in elements]
	return max(parsed, key=lambda message: message["at"])


def _message(raw: Any, conversation_urn: str, mailbox: str, people: list[_Person]) -> dict[str, Any]:
	if not isinstance(raw, dict) or raw.get("_type") != MESSAGE_TYPE:
		raise _Unread("a message is not in LinkedIn's shape", raw)
	urn = raw.get("entityUrn")
	named = MESSAGE_URN_RE.fullmatch(urn) if isinstance(urn, str) else None
	if named is None or named.group(1) != mailbox:
		raise _Unread("a message's urn is not the mailbox's", raw)
	conversation = raw.get("conversation")
	if isinstance(conversation, dict) and conversation.get("entityUrn") != conversation_urn:
		raise _Unread("a message names another conversation", raw)
	delivered = raw.get("deliveredAt")
	if not _count(delivered):
		raise _Unread("a message carries no delivery time", raw)
	body = raw.get("body")
	# An attachment sent alone carries no words, and says nothing.
	if body is not None and not (isinstance(body, dict) and isinstance(body.get("text"), str)):
		raise _Unread("a message's body is not in LinkedIn's shape", raw)
	text = clean(body["text"]) if body is not None else ""
	if len(text) > MAX_MESSAGE_TEXT:
		raise _Unread("a message runs past what a read carries", raw)
	sender = raw.get("sender")
	sender_urn = sender.get("entityUrn") if isinstance(sender, dict) else None
	author = next((person for person in people if person.urn == sender_urn), None)
	if author is None:
		raise _Unread("a message's sender is no participant of its conversation", raw)
	return {
		"messageId": urn,
		"text": text,
		"textHash": text_hash(text),
		"fromSelf": author.is_self,
		"authorProfileId": author.profile_id,
		"at": delivered,
	}


def _text(value: Any) -> str:
	"""An attributed text's words, or nothing."""
	return value["text"] if isinstance(value, dict) and isinstance(value.get("text"), str) else ""


def _count(value: Any) -> bool:
	return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def response_fingerprint(body: Any) -> str:
	"""A hash of the response's SHAPE — the collection's name and the keys a
	conversation, a participant and a message carry, with no value in it. Two
	lists of one layout agree."""
	tokens: set[str] = set()
	data = body.get("data") if isinstance(body, dict) else None
	if isinstance(body, dict):
		tokens.update(f"top:{key}" for key in body)
	if isinstance(data, dict):
		tokens.update(f"data:{key}" for key in data)
		collection = _collection(body)
		for element in (collection or {}).get("elements") or []:
			if not isinstance(element, dict):
				continue
			tokens.update(f"conversation:{key}" for key in element)
			for person in element.get("conversationParticipants") or []:
				if isinstance(person, dict):
					tokens.update(f"participant:{key}" for key in person)
			for message in (element.get("messages") or {}).get("elements") or []:
				if isinstance(message, dict):
					tokens.update(f"message:{key}" for key in message)
	return hashlib.sha256("\n".join(sorted(tokens)).encode()).hexdigest()[:16]


class HistoryUnavailable(Exception):
	"""LinkedIn did not answer for a conversation's history as this module
	knows it — a stale query id, a status, a shape. Never a SidecarError of its
	own: the caller opens the conversation instead."""


def messages_query(url: str) -> tuple[str, str] | None:
	"""("latest" or "older", the query id) of a history request the page made;
	None for any other address."""
	match = _MESSAGES_QUERY_RE.search(url)
	if match is None:
		return None
	return ("older" if "variables=(deliveredAt:" in url else "latest", match.group(1))


def request_mailbox(url: str) -> str | None:
	"""The mailbox a conversation-list request names in its variables — sent
	percent-encoded, its parentheses sometimes too: the signed-in session's
	own identity on LinkedIn. None where it names none."""
	match = _MAILBOX_VARIABLE_RE.search(unquote(urlparse(url).query))
	return match.group(1) if match is not None else None


def account_mailbox(url: str, body: Any, me: Any, *, own_profile_id: str) -> str:
	"""The mailbox the list's own request named, as the connected account's.

	The request is the signed-in session's, so its mailbox is the account's
	own — unless `me`, the account's `/voyager/api/me` where the same load
	fetched it, names another public identifier than the connected account's,
	or another member than the mailbox's (`fs_miniProfile` and `fsd_profile`
	carry one id): then the read is refused. A `/me` the load did not fetch,
	or that names neither, leaves the mailbox standing alone. A request that
	names no mailbox is drift."""
	mailbox = request_mailbox(url)
	if mailbox is None:
		raise _drift("the list's own request names no mailbox", None, response_fingerprint(body))
	if isinstance(me, dict) and isinstance(me.get("data"), dict):
		public = own_public_identifier(me)
		member = own_member_id(me)
		if (public is not None and public.lower() != own_profile_id) or (
			member is not None and PROFILE_URN_PREFIX + member != mailbox
		):
			raise SidecarError(
				"CONNECTED_ACCOUNT_CHANGED",
				"the conversation list's mailbox is not the connected account's",
			)
	return mailbox


def conversation_urn(mailbox: str, thread_id: str) -> str:
	return f"urn:li:msg_conversation:({mailbox},{thread_id})"


def history_path(query_id: str, urn: str, *, before: int | None = None) -> str:
	"""The address of one page of a conversation's history: its newest, or the
	page before `before`. The urn is percent-encoded whole — its parentheses,
	colons, comma and `=` included, which LinkedIn refuses bare — inside the
	variables' own literal parentheses."""
	encoded = quote(urn, safe="")
	variables = (
		f"(conversationUrn:{encoded})"
		if before is None
		else f"(deliveredAt:{before},conversationUrn:{encoded},countBefore:{HISTORY_PAGE},countAfter:0)"
	)
	return f"{GRAPHQL_PATH}?queryId={query_id}&variables={variables}"


def conversation_history(
	body: Any, *, urn: str, mailbox: str, own_profile_id: str, members: Mapping[str, str] | None = None
) -> tuple[list[dict[str, Any]], int]:
	"""(the page's messages oldest first, how many it listed), or
	HistoryUnavailable. Every message must be the conversation's own, by a
	sender LinkedIn names in full — the account by the mailbox, anyone else by
	the profile their own address names, or `members` knows for their member
	urn."""
	data = body.get("data") if isinstance(body, dict) else None
	found = (
		[value for key, value in data.items() if _MESSAGES_COLLECTION_RE.fullmatch(key)] if isinstance(data, dict) else []
	)
	elements = found[0].get("elements") if len(found) == 1 and isinstance(found[0], dict) else None
	if not isinstance(elements, list):
		raise HistoryUnavailable("the answer holds no message collection")
	messages: dict[str, dict[str, Any]] = {}
	for element in elements:
		try:
			raw = element.get("sender") if isinstance(element, dict) else None
			sender = _participant(raw, mailbox, own_profile_id, members)
			message = _message(element, urn, mailbox, [sender])
		except _Unread as unread:
			raise HistoryUnavailable(f"a message was not recognised: {unread}") from None
		if message["authorProfileId"] is None:
			raise HistoryUnavailable(
				"a message's sender is known only by member id"
				if sender.member_urn is not None
				else "a message's sender has no profile"
			)
		messages[message["messageId"]] = message
	ordered = sorted(messages.values(), key=lambda message: message["at"])
	return [
		{
			"messageId": message["messageId"],
			"fromSelf": message["fromSelf"],
			"authorProfileId": message["authorProfileId"],
			"text": message["text"],
			"textHash": message["textHash"],
			"sentAt": message["at"],
		}
		for message in ordered
	], len(elements)


def _drift(message: str, at: Any, fingerprint: str) -> SidecarError:
	return SidecarError(
		"UI_DRIFT",
		f"the conversation list was not recognised: {message}",
		detail={
			"pageFingerprint": fingerprint,
			"selectorPack": SELECTOR_PACK_VERSION,
			# The object's keys, never its values: enough to see what moved,
			# and nothing anyone wrote.
			"excerpt": json.dumps(sorted(at))[:EXCERPT_CHARS] if isinstance(at, dict) else "",
		},
	)
