"""One direct message, sent as LinkedIn's own messaging client sends it.

LinkedIn's own messaging page sends a message as one POST of its words to
LinkedIn's messaging API (`createMessage`, read from its bundle 2026-10-20 —
`messenger-sdk`'s `sendMessageToConversationAPI` and
`sendFirstMessageToRecipientsAPI`). The sidecar makes that one request from
inside the page, in the page's session,
with the page's own headers beside its CSRF token — the history read's
discipline (`conversations.py`), applied to the one write. Nothing is typed,
focused or pressed: the composer, and the editor that once refused typed
words, are never touched — only read, where the read is the page.

What a DM ever touches, and nothing else:

- the account's conversation list and the conversation's history, read as a
  history read reads them, or the conversation's own page where its history
  cannot answer — every rule of who is in it and where it stands here, over
  that read (`admit`);
- one POST of `create_message_body` to `CREATE_MESSAGE_PATH`, after the
  journal holds the attempt as CLICKING, carrying exactly the owner's words.

NEVER into a group, a conversation whose other person is not the recipient by
the member urn the conversation is bound to (by profile id where none is bound),
one that moved past the message the DM was written after, or — where the read
was the conversation's page, the one read that shows its composer — one whose
composer holds words that are not these: someone is writing there.

The request is idempotent by construction. Its `originToken` — the client id
LinkedIn's own client mints per message and echoes back — is derived from the
operation id (`origin_token`), and `dedupeByClientGeneratedToken` asks
LinkedIn to answer a second request with that token with the message the
first created, as its own client asks on a retry. The journal is what stops a
second POST; the token is what a second could never get past.

What a send came to is LinkedIn's answer to that POST (`send_outcome`): the
message it created, in the mailbox, with these words, is the receipt; a
refusal it states is the message refused; anything else — no answer, a
timeout, a server error, an answer this module does not read — settles
nothing, and only a read of the conversation does (`sent_message`).
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from typing import Any, Literal

from .conversations import BACKEND_THREAD_PREFIX, MESSAGE_URN_RE
from .messaging import HEADER_CLASS, MESSAGE_LIST_CLASS, THREAD_CLASS, THREAD_ID_RE, Snapshot
from .protocol import SidecarError
from .replies import Element, clean, parse_markup, text_hash

# Where LinkedIn's messaging client POSTs a message: `messengerResource`'s
# restli address for `messengerMessages`, with `action=createMessage` — the
# same for a message into a conversation and the first one to a member.
CREATE_MESSAGE_PATH = "/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage"
# How long the one POST waits for LinkedIn's answer before it is uncertain.
SEND_TIMEOUT_MS = 20_000
# LinkedIn's statuses that refuse nothing: a request it timed out on, one in
# conflict with another, one too early or too many. Every other 4xx refuses
# the message, and nothing was created.
_UNSETTLED_STATUSES = frozenset({408, 409, 425, 429})
# The most of LinkedIn's own words a refusal keeps.
_REASON_CHARS = 300

# What LinkedIn prints on a conversation it will not carry a message in.
# Words LinkedIn prints, never a guess at what a silence means.
_REFUSED_RE = re.compile(
	r"\byou can(?:'t|’t|not) (?:message|reply|send)\b"
	r"|\bcan(?:'t|’t|not) reply to this conversation\b"
	r"|\bmessage (?:failed to send|(?:was )?not sent)\b"
	r"|\bcould(?:n't|n’t| not) send\b"
	r"|\bunable to send\b"
	r"|\bthis conversation is no longer available\b"
	r"|\bsomething went wrong\b",
	re.IGNORECASE,
)

Refusal = Literal[
	"group_thread",
	"participants_mismatch",
	"thread_moved",
	"human_draft",
	"messaging_restricted",
]


class Refused(Exception):
	"""A DM refused before anything was sent: the conversation as the read
	showed it. Never a page fault — those are `SidecarError`s."""

	def __init__(self, reason: Refusal, detail: str | None = None) -> None:
		super().__init__(detail or reason)
		self.reason: Refusal = reason
		self.detail = detail


# Serialises `main` as MESSAGING_SNAPSHOT_JS does, and every alert and toast on
# the page — where LinkedIn prints a refusal.
DM_SNAPSHOT_JS = r"""() => {
  const root = document.querySelector('main');
  return JSON.stringify({
    url: location.href,
    html: root ? root.outerHTML : '',
    alerts: [...document.querySelectorAll('[role="alert"], .artdeco-toast-item')]
      .filter(alert => !root || !root.contains(alert))
      .map(alert => alert.outerHTML)
  });
}"""

# Whether the page holds the session cookie SEND_MESSAGE_JS signs with — its
# CSRF token. Reads one cookie's presence, never its value.
SESSION_COOKIE_JS = r"""() => JSON.stringify({ready: /JSESSIONID="?[^";]+/.test(document.cookie)})"""

# The one POST, as the messaging client makes it: the body as a string, the
# page's own headers, the CSRF token from the session cookie, `accept:
# application/json`. The status is kept before the answer is read, so an
# answer cut short still says how far it got. Never retried here.
SEND_MESSAGE_JS = r"""(path, body, pageHeaders, timeoutMs) => (async () => {
  const jsession = (document.cookie.match(/JSESSIONID="?([^";]+)"?/) || [])[1] || '';
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let status = 0;
  try {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      signal: abort.signal,
      headers: {
        ...JSON.parse(pageHeaders),
        'csrf-token': jsession,
        'accept': 'application/json',
        'x-restli-protocol-version': '2.0.0',
      },
      body,
    });
    status = res.status;
    const text = await res.text();
    return JSON.stringify({status, body: text});
  } catch (e) {
    return JSON.stringify({status, error: e && e.name === 'AbortError' ? 'timed out' : String(e)});
  } finally {
    clearTimeout(timer);
  }
})()"""


@dataclass(frozen=True)
class DmSnapshot:
	page: Snapshot
	alerts: list[Element]


def dm_snapshot_from_page(raw: Any) -> DmSnapshot:
	"""What DM_SNAPSHOT_JS returned, or drift when it is not that shape."""
	if (
		not isinstance(raw, dict)
		or not isinstance(raw.get("url"), str)
		or not isinstance(raw.get("html"), str)
		or not isinstance(raw.get("alerts"), list)
		or not all(isinstance(alert, str) for alert in raw["alerts"])
	):
		raise SidecarError("UI_DRIFT", "the conversation page could not be serialised for writing")
	return DmSnapshot(
		page=Snapshot(url=raw["url"], root=parse_markup(raw["html"])),
		alerts=[parse_markup(alert) for alert in raw["alerts"]],
	)


def words_hash(text: str) -> str:
	"""The hash a read gives these words once they are a message: whitespace,
	line breaks included, collapsed (`messaging.py` reads a body as its lines
	joined by spaces)."""
	return text_hash(clean(text))


def refusal_shown(snapshot: DmSnapshot) -> str | None:
	"""LinkedIn's own words refusing a message in this conversation, or None:
	any alert or toast, and the thread where its composer would be. The
	messages and the header are left out — anyone can write "you can't
	message me" in one."""
	notices: list[Element] = list(snapshot.alerts)
	for thread in (element for element in snapshot.page.root.iter() if element.has_class(THREAD_CLASS)):
		notices += [
			child
			for child in thread.children
			if isinstance(child, Element)
			and not child.has_class(HEADER_CLASS)
			and not any(element.has_class(MESSAGE_LIST_CLASS) for element in child.iter())
		]
	return next((text[:500] for text in (element.text() for element in notices) if _REFUSED_RE.search(text)), None)


def admit(read: dict[str, Any], *, recipient: str, member_urn: str | None = None, after: str, text: str) -> None:
	"""Refuse unless the read is a two-person conversation with the recipient
	(`_is_recipient`) whose newest message is still the one the DM was written
	after, and whose composer, where the read shows one, holds nothing but, at
	most, these words."""
	participants = read.get("participants") or []
	if read.get("group") is True or len(participants) != 2:
		raise Refused("group_thread")
	others = [participant for participant in participants if participant.get("isSelf") is not True]
	if len(others) != 1 or not _is_recipient(others[0], recipient=recipient, member_urn=member_urn):
		raise Refused("participants_mismatch", "the conversation's other person is not the one it is bound to")
	messages = read.get("messages") or []
	tail = messages[-1]["messageId"] if messages else None
	if tail != after:
		raise Refused("thread_moved", "the conversation has moved past the message the DM was written after")
	composer = read.get("composer") or {}
	if composer.get("hasDraft") is True and composer.get("draftHash") != words_hash(text):
		raise Refused("human_draft", "the conversation's composer holds words nobody has sent")


def _is_recipient(participant: dict[str, Any], *, recipient: str, member_urn: str | None) -> bool:
	"""Whether a conversation's other person is the recipient: by member urn —
	LinkedIn's own identity for a member, the one the conversation is bound to —
	where the read and the caller both name one, else by profile id. A person
	named by neither is no one."""
	shown = participant.get("memberUrn")
	if shown is not None and member_urn is not None:
		return shown == member_urn
	return participant.get("profileId") == recipient


def origin_token(operation_id: str) -> str:
	"""The message's `originToken`, the same for every attempt under one
	operation id: a UUID — LinkedIn's client mints one per message
	(`crypto.randomUUID`) — of version 4's shape, from the id's hash."""
	raw = bytearray(hashlib.sha256(f"engager-dm:{operation_id}".encode()).digest()[:16])
	raw[6] = (raw[6] & 0x0F) | 0x40
	raw[8] = (raw[8] & 0x3F) | 0x80
	return str(uuid.UUID(bytes=bytes(raw)))


def create_message_body(
	*,
	text: str,
	mailbox_urn: str,
	origin: str,
	conversation_urn: str | None = None,
	recipient_urn: str | None = None,
) -> dict[str, Any]:
	"""What the POST carries, as LinkedIn's client builds it: the owner's
	words exactly, unformatted; into `conversation_urn`, or — a first message
	— to `recipient_urn`, never both; the `trackingId` its client derives from
	the token (the token's sixteen bytes as characters); and the ask that a
	second request with this token be answered with the first one's message."""
	if (conversation_urn is None) == (recipient_urn is None):
		raise ValueError("a message goes into one conversation or to one recipient")
	message: dict[str, Any] = {"body": {"text": text, "attributes": []}}
	if conversation_urn is not None:
		message["conversationUrn"] = conversation_urn
	message["originToken"] = origin
	body: dict[str, Any] = {
		"message": message,
		"mailboxUrn": mailbox_urn,
		"trackingId": uuid.UUID(origin).bytes.decode("latin-1"),
		"dedupeByClientGeneratedToken": True,
	}
	if recipient_urn is not None:
		body["hostRecipientUrns"] = [recipient_urn]
	return body


def wire_body(body: dict[str, Any]) -> str:
	"""The body as the POST sends it: compact JSON, as `JSON.stringify` writes
	it."""
	return json.dumps(body, ensure_ascii=False, separators=(",", ":"))


def send_outcome(answer: Any, *, mailbox_urn: str, text: str, origin: str, thread_id: str | None) -> dict[str, Any]:
	"""What LinkedIn's answer to the one POST says, as SEND_MESSAGE_JS handed
	it over: `confirmed` with the message it created (`created_message`);
	`blocked` with its stated refusal — a 4xx, nothing created; `uncertain`,
	with what was seen, for anything else — no answer, a timeout, a 5xx, a
	status that refuses nothing, an answer this module cannot read. Every one
	keeps a plain detail."""
	status = answer.get("status") if isinstance(answer, dict) else None
	if not isinstance(status, int) or isinstance(status, bool):
		return {"state": "uncertain", "error": "the page handed back no answer to the message's request"}
	if status == 0:
		failed = answer.get("error") or "no status"
		return {"state": "uncertain", "error": f"LinkedIn did not answer the message's request: {failed}"}
	if 200 <= status < 300:
		created = created_message(
			answer.get("body"), mailbox_urn=mailbox_urn, text=text, origin=origin, thread_id=thread_id
		)
		if isinstance(created, str):
			return {"state": "uncertain", "error": f"LinkedIn answered HTTP {status}, but {created}"}
		return {"state": "confirmed", "message": created}
	reason = stated_reason(answer.get("body"))
	said = f"HTTP {status}: {reason}" if reason else f"HTTP {status}"
	if 400 <= status < 500 and status not in _UNSETTLED_STATUSES:
		return {"state": "blocked", "detail": f"LinkedIn refused the message ({said})"}
	return {
		"state": "uncertain",
		"error": f"LinkedIn's answer settles nothing ({said})",
		**({"rateLimited": True} if status == 429 else {}),
	}


def created_message(
	body: Any, *, mailbox_urn: str, text: str, origin: str, thread_id: str | None
) -> dict[str, Any] | str:
	"""The message a 2xx answer says LinkedIn created — its urn in the
	mailbox, its delivery time, the hash of its words, the conversation it is
	in — or, as a clause, why the answer is not one: another mailbox's urn,
	another token (LinkedIn's client refuses that answer too), other words,
	another conversation than `thread_id`, where one is named."""
	try:
		parsed = json.loads(body) if isinstance(body, str) else None
	except json.JSONDecodeError:
		parsed = None
	# The client unwraps an answer that holds only its `value`.
	value = parsed["value"] if isinstance(parsed, dict) and set(parsed) == {"value"} else parsed
	if not isinstance(value, dict):
		return "its answer is not the message LinkedIn's client reads"
	urn = value.get("entityUrn")
	named = MESSAGE_URN_RE.fullmatch(urn) if isinstance(urn, str) else None
	if named is None or named.group(1) != mailbox_urn:
		return "its answer names no message in the account's mailbox"
	if value.get("originToken") not in (None, origin):
		return "its answer carries another message's originToken"
	delivered = value.get("deliveredAt")
	if not isinstance(delivered, int) or isinstance(delivered, bool) or delivered <= 0:
		return "its answer carries no delivery time"
	words = value.get("body").get("text") if isinstance(value.get("body"), dict) else None
	if not isinstance(words, str) or words_hash(words) != words_hash(text):
		return "its answer carries other words than the message's"
	backend = value.get("backendConversationUrn")
	conversation = backend.removeprefix(BACKEND_THREAD_PREFIX) if isinstance(backend, str) else None
	if (
		conversation is None
		or not backend.startswith(BACKEND_THREAD_PREFIX)
		or not THREAD_ID_RE.fullmatch(conversation)
		or (thread_id is not None and conversation != thread_id)
	):
		return "its answer puts the message in another conversation"
	return {
		"messageId": urn,
		"sentAt": delivered,
		"textHash": words_hash(words),
		"threadId": conversation,
		"answerFingerprint": _answer_fingerprint(value),
	}


def stated_reason(body: Any) -> str | None:
	"""LinkedIn's own words for a refusal — the restli error's `message` and
	`code`, where its answer is that JSON — or None."""
	try:
		parsed = json.loads(body) if isinstance(body, str) else None
	except json.JSONDecodeError:
		return None
	if not isinstance(parsed, dict):
		return None
	said = [parsed.get(key) for key in ("serviceErrorCode", "code", "message")]
	parts = [str(value) for value in said if isinstance(value, (str, int)) and not isinstance(value, bool) and str(value).strip()]
	return clean(" ".join(parts))[:_REASON_CHARS] or None


def _answer_fingerprint(value: dict[str, Any]) -> str:
	"""A hash of the answer's SHAPE — its keys and its body's — with no value
	in it."""
	keys = [f"message:{key}" for key in value]
	if isinstance(value.get("body"), dict):
		keys += [f"body:{key}" for key in value["body"]]
	return hashlib.sha256("\n".join(sorted(keys)).encode()).hexdigest()[:16]


def posted_receipt(message: dict[str, Any], *, observed_at: int, session_id: str) -> dict[str, Any]:
	"""What a confirmation carries, in `receipt`'s shape: the message LinkedIn
	created, newest in its conversation as far as the answer says."""
	return {
		"messageId": message["messageId"],
		"sentAt": message["sentAt"],
		"textHash": message["textHash"],
		"tailMessageId": message["messageId"],
		"observedAt": observed_at,
		"sessionId": session_id,
		"pageFingerprint": message["answerFingerprint"],
	}


def sent_message(read: dict[str, Any], *, after: str, text: str) -> dict[str, Any] | None:
	"""Our message in the read: from the account, after the message the DM was
	written after, carrying exactly these words. None when the read does not
	reach that message — it then cannot say what came after it."""
	messages = read.get("messages") or []
	at = next((index for index, message in enumerate(messages) if message.get("messageId") == after), None)
	if at is None:
		return None
	wanted = words_hash(text)
	return next(
		(
			message
			for message in messages[at + 1 :]
			if message.get("fromSelf") is True and message.get("textHash") == wanted
		),
		None,
	)


def ends_at(read: dict[str, Any], after: str) -> bool:
	"""Whether the read's newest message is the one the DM was written after:
	nothing came since it, ours included."""
	messages = read.get("messages") or []
	return bool(messages) and messages[-1].get("messageId") == after


def receipt(read: dict[str, Any], message: dict[str, Any]) -> dict[str, Any]:
	"""What a confirmation a read made carries: our message as the thread
	showed it, and the read that showed it."""
	messages = read.get("messages") or []
	return {
		"messageId": message["messageId"],
		"sentAt": message.get("sentAt"),
		"textHash": message["textHash"],
		"tailMessageId": messages[-1]["messageId"],
		"observedAt": read["observedAt"],
		"sessionId": read["sessionId"],
		"pageFingerprint": read["pageFingerprint"],
	}
