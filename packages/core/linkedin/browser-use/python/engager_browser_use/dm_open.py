"""The first message to a connection, into a conversation that does not exist yet.

`dm_write.py` writes into a conversation a read has bound; this opens one. What
it ever touches, and nothing else:

- the member's own profile, read for its data (`profile_data.py`): a
  connection (`Distance1`), and the address their Message trigger
  (`messageActor`) navigates to — the compose view for exactly their profile
  urn, never a Message button pressed;
- the account's conversation list (`conversations.py`): none of them a 1:1
  with the member, so nothing here ever writes into a conversation that
  exists — that is `send_dm`'s;
- the compose view at that address, LinkedIn's own link to it — the member's
  profile urn and the same member again as `recipient` — whose own load names
  exactly that member, and never anyone else, as the recipient it asks about:
  the compose context (`voyagerMessagingDashComposeViewContexts`, its
  `recipients` variable) or the compose option
  (`voyagerMessagingDashComposeOptions`, its urn and `recipientUrns`), neither
  a paid InMail;
- one POST from that view, after the journal holds the attempt as CLICKING,
  of the message to that profile urn alone (`dm_write.create_message_body`,
  its `hostRecipientUrns`) — never a composer typed into or a Send pressed.

What a send came to is LinkedIn's answer to that POST (`dm_write.send_outcome`)
and the conversation it names, read from its history without opening it: a
1:1 with the member — by the profile urn their profile's data named — holding
a message from the account in exactly these words, sent no earlier than the
press. That binds the new conversation to this recipient before anything is
called sent. Where the answer settles nothing, the account's conversation list
read afresh does the same. Nothing sent is proven only by a list that is whole
since the press and holds no conversation with them, and only time since the
press turns that into evidence (the caller's settle).

The binding is read from the capture of 2026-10-15 that opened the compose
view with LinkedIn's own Message link: with `recipient` it asks the context
for `recipients:List(<profile urn>)` and the option for the member, and its
own lookup of the conversations with them lists none; opened by `profileUrn`
alone the context was asked for no one, which is why a view that does not name
the member refuses and nothing is sent.
"""

from __future__ import annotations

import re
from typing import Any, Literal
from urllib.parse import parse_qs, unquote, urljoin, urlparse

from .dm_write import receipt, words_hash
from .profile_data import LINKEDIN_ORIGIN, PROFILE_URN_PREFIX, ProfileData

COMPOSE_PATH = "/messaging/compose/"
# How far a message's time may sit before the press and still be the one it
# sent: LinkedIn's clock against this machine's.
CLOCK_SKEW_MS = 120_000

# Any compose-context request, any compose-option read, and the compose
# view's own lookup of the conversations with a recipient (a conversation-list
# request whose variables name `recipients`) — and the variables once
# percent-decoded.
COMPOSE_CONTEXT_RE = re.compile(r"/voyager/api/graphql\?(?:[^#]*&)?queryId=voyagerMessagingDashComposeViewContexts\.")
COMPOSE_OPTIONS_RE = re.compile(r"/voyager/api/voyagerMessagingDashComposeOptions/")
RECIPIENT_CONVERSATIONS_RE = re.compile(
	r"/voyager/api/voyagerMessagingGraphQL/graphql\?(?:[^#]*&)?queryId=messengerConversations\.[^#]*recipients"
)
_RECIPIENTS_RE = re.compile(r"[(,]recipients:List\(([^()]*)\)")
_OPTION_URN_RE = re.compile(r"urn:li:fsd_composeOption:\(([A-Za-z0-9_-]+),")

OpenRefusal = Literal[
	"not_connected",
	"recipient_unverified",
	"message_unavailable",
	"conversation_exists",
	"conversation_unverified",
	"recipient_unbound",
	"messaging_restricted",
]


class Refused(Exception):
	"""A first message refused before anything was sent."""

	def __init__(self, reason: OpenRefusal, detail: str | None = None) -> None:
		super().__init__(detail or reason)
		self.reason: OpenRefusal = reason
		self.detail = detail


def admit(relationship: dict[str, Any], *, recipient: str) -> str:
	"""The member's profile urn, where their profile's data shows them as the
	member asked for and a connection; else Refused."""
	profile = relationship.get("profile") or {}
	if profile.get("verified") is not True or profile.get("id") != recipient:
		raise Refused("recipient_unverified", "the profile read is not verified as the member asked for")
	if relationship.get("degree") != "1st" or relationship.get("pending") != "none":
		raise Refused("not_connected", f"the profile shows degree {relationship.get('degree')!r}")
	urn = relationship.get("profileUrn")
	if not isinstance(urn, str) or not urn.startswith(PROFILE_URN_PREFIX):
		raise Refused("recipient_unverified", "the profile read names no profile urn")
	return urn


def compose_address(data: ProfileData, profile_urn: str) -> str:
	"""The address the member's Message trigger navigates to: LinkedIn's own
	link to the compose view, for exactly their profile urn and naming them
	again as its `recipient`. A trigger for another member, none, or two is
	`message_unavailable`; a trigger that does not name them as the recipient
	is `recipient_unbound`, for the view it opens would be asked about no one."""
	urn_id = profile_urn.removeprefix(PROFILE_URN_PREFIX)
	addresses: set[str] = set()
	for raw in data.messages:
		address = urljoin(LINKEDIN_ORIGIN, raw)
		parsed = urlparse(address)
		if parsed.netloc != urlparse(LINKEDIN_ORIGIN).netloc or parsed.path != COMPOSE_PATH:
			continue
		query = parse_qs(parsed.query)
		if query.get("profileUrn") != [profile_urn]:
			raise Refused("message_unavailable", "the Message trigger names another member")
		if query.get("recipient") != [urn_id]:
			raise Refused("recipient_unbound", "the Message trigger does not name them as the recipient")
		addresses.add(address)
	if len(addresses) != 1:
		raise Refused("message_unavailable", f"the profile's data carries {len(addresses)} Message addresses")
	return addresses.pop()


def existing_conversation(threads: list[dict[str, Any]], *, recipient: str, profile_urn: str) -> dict[str, Any] | None:
	"""The listed 1:1 conversation with the member, if any — by their profile
	urn, which the list names every member by, or by their profile id."""
	return next(
		(
			thread
			for thread in threads
			if thread.get("group") is not True
			and len(thread.get("participants") or []) == 1
			and _is_member(thread["participants"][0], recipient=recipient, profile_urn=profile_urn)
		),
		None,
	)


def compose_evidence_for(profile_urn: str) -> re.Pattern[str]:
	"""A request that can bind the compose view to this member: the context of
	a message to exactly them (their urn as the page may spell it in its
	variables), or the compose option for them."""
	urn = r"(?::|%3[Aa])".join(re.escape(part) for part in profile_urn.split(":"))
	urn_id = re.escape(profile_urn.removeprefix(PROFILE_URN_PREFIX))
	return re.compile(
		r"^(?=[^#]*[?&]queryId=voyagerMessagingDashComposeViewContexts\.)"
		r"(?=[^#]*recipients(?::|%3[Aa])List(?:\(|%28)" + urn + r"(?:\)|%29))"
		r"|/voyager/api/voyagerMessagingDashComposeOptions/"
		r"[^#]*fsd_composeOption(?::|%3[Aa])(?:\(|%28)" + urn_id + r"(?:,|%2[Cc])"
	)


def variables_recipients(url: str) -> list[str]:
	"""The recipients a request's variables name, once percent-decoded."""
	variables = unquote(parse_qs(urlparse(url).query).get("variables", [""])[0])
	listed = _RECIPIENTS_RE.search(variables)
	return [item for item in (listed.group(1).split(",") if listed else []) if item]


def admit_binding(landed: str, captured: list[Any], profile_urn: str) -> None:
	"""Refuse unless the compose view's own load names exactly the member, and
	never anyone else, as the recipient: the context it asked for
	(`recipients:List(…)`) or the compose option it read, either naming them,
	none naming another, the address it ended on contradicting neither — and
	LinkedIn's answers not blocking the message."""
	urn_id = profile_urn.removeprefix(PROFILE_URN_PREFIX)
	shown = parse_qs(urlparse(landed).query)
	if shown.get("profileUrn", [profile_urn]) != [profile_urn] or shown.get("recipient", [urn_id]) != [urn_id]:
		raise Refused("recipient_unbound", "the compose view's address names another recipient")
	named = False
	for response in captured:
		if COMPOSE_CONTEXT_RE.search(response.url):
			named |= _context_names(response, profile_urn)
		elif COMPOSE_OPTIONS_RE.search(response.url):
			named |= _option_names(response, profile_urn)
	if not named:
		raise Refused("recipient_unbound", "the compose view's load never named the member as its recipient")


def lookup_conversations(captured: list[Any], profile_urn: str) -> int | None:
	"""How many conversations the compose view's own lookup of exactly this
	member's found — none, where the account has never written to them — or
	None where it asked no such thing or its answer cannot be read."""
	counts: list[int] = []
	for response in captured:
		if not RECIPIENT_CONVERSATIONS_RE.search(response.url) or variables_recipients(response.url) != [profile_urn]:
			continue
		data = response.body.get("data") if isinstance(response.body, dict) else None
		found = data.get("messengerConversationsByRecipients") if isinstance(data, dict) else None
		elements = found.get("elements") if isinstance(found, dict) else None
		if isinstance(elements, list):
			counts.append(len(elements))
	return sum(counts) if counts else None


def opened_message(read: dict[str, Any], *, recipient: str, text: str, since_ms: int) -> dict[str, Any] | None:
	"""Our message in a history read of the member's conversation: the read a
	1:1 with them, the message from the account in exactly these words, sent
	no earlier than the press. None otherwise."""
	participants = read.get("participants") or []
	others = [person for person in participants if person.get("isSelf") is not True]
	if (
		read.get("group") is True
		or len(participants) != 2
		or len(others) != 1
		or others[0].get("profileId") != recipient
	):
		return None
	wanted = words_hash(text)
	return next(
		(
			message
			for message in reversed(read.get("messages") or [])
			if message.get("fromSelf") is True
			and message.get("textHash") == wanted
			and isinstance(message.get("sentAt"), int)
			and message["sentAt"] >= since_ms - CLOCK_SKEW_MS
		),
		None,
	)


def opened_receipt(read: dict[str, Any], message: dict[str, Any]) -> dict[str, Any]:
	"""What a confirmation carries: our message as `dm_write.receipt` reads
	it, and the conversation it opened."""
	return {**receipt(read, message), "threadId": read["threadId"]}


def conversation_of(read: dict[str, Any]) -> dict[str, Any]:
	"""The history read as a confirmation carries it, for the caller to bind."""
	keys = (
		"threadId",
		"participants",
		"group",
		"messages",
		"complete",
		"observedAt",
		"sessionId",
		"pageFingerprint",
		"selectorPack",
	)
	return {key: read[key] for key in keys}


def _is_member(person: dict[str, Any], *, recipient: str, profile_urn: str) -> bool:
	return person.get("memberUrn") == profile_urn or person.get("profileId") == recipient


def _context_names(response: Any, profile_urn: str) -> bool:
	"""Whether a compose-context request names the member alone, as the page
	spelled it — their urn or their bare id. A request naming anyone else is
	Refused, and one LinkedIn answers with a block is `messaging_restricted`."""
	recipients = variables_recipients(response.url)
	if not recipients:
		return False
	if recipients not in ([profile_urn], [profile_urn.removeprefix(PROFILE_URN_PREFIX)]):
		raise Refused("recipient_unbound", "the compose view asked for another recipient")
	if _blocked(response.body):
		raise Refused("messaging_restricted", "LinkedIn's compose context blocks the message")
	return True


def _option_names(response: Any, profile_urn: str) -> bool:
	"""Whether a compose option read is for the member alone: the option's urn
	and the recipient its answer carries both name them. Naming anyone else is
	Refused, and a paid InMail is `messaging_restricted`."""
	named = _OPTION_URN_RE.search(unquote(urlparse(response.url).path))
	body = response.body.get("data") if isinstance(response.body, dict) else None
	navigation = body.get("composeNavigationContext") if isinstance(body, dict) else None
	recipients = navigation.get("recipientUrns") if isinstance(navigation, dict) else None
	if named is None or not isinstance(recipients, list) or not recipients:
		return False
	if named.group(1) != profile_urn.removeprefix(PROFILE_URN_PREFIX) or recipients != [profile_urn]:
		raise Refused("recipient_unbound", "the compose option is for another recipient")
	if navigation.get("paidInMail") is not False:
		raise Refused("messaging_restricted", "LinkedIn would send this as a paid InMail")
	return True


def _blocked(body: Any) -> bool:
	"""Whether LinkedIn's compose context answers with anything but a clear
	way through: one context, whose blocked footer and trust intervention are
	both stated and both off. Anything else — no body, no context, several, a
	flag left unstated — blocks."""
	data = body.get("data") if isinstance(body, dict) else None
	data = data.get("data") if isinstance(data, dict) else None
	collection = data.get("messagingDashComposeViewContextsByRecipients") if isinstance(data, dict) else None
	elements = collection.get("elements") if isinstance(collection, dict) else None
	if not isinstance(elements, list) or len(elements) != 1 or not isinstance(elements[0], dict):
		return True
	context = elements[0]
	return (
		context.get("showBlockedFooter") is not False
		or "trustInterventionPage" not in context
		or context["trustInterventionPage"] is not None
	)
