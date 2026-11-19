"""The invitations people sent the connected account, read from its invitations page's own data.

The received-invitations page is server-driven: the document LinkedIn serves
for it carries the data it renders from as React flight rows, in a
`#rehydrate-data` script (read in the document response 2026-10-14), gone from
the page once it has rendered. The sidecar keeps the navigation's own response
and `thread_data.py` reads its rows; every rule of the read runs here, over
their values. No class name, heading or label decides a fact, and nothing is
pressed.

LinkedIn's own keys are the anchor:

  - a REQUEST is a row keyed `invitation_manager_row_urn:li:invitation:<id>`;
  - its facts are the `addaInvitationAction` server requests its Accept,
    Ignore and Reject carry — `invitationType`, `invitationUrn.invitationId`,
    `profileUrn.profileId` — wherever the rows hold them;
  - its state is the model state `invitation_action_state_<id>` the page
    starts from (`modelStates`), never one an action would set, under
    whichever of its two keys names it (`thread_data.state_name`);
  - its sender is the member `profileUrn.profileId` names, by the public
    slug Engager keeps people by, which the page's own
    `{vanityName, isVanityNameResolved, vieweeProfileId}` payload binds to
    that id; their name is the one the Accept's own label carries ("Accept
    <Name>’s invitation"), else the slug.

Only a `GenericInvitationType_CONNECTION` request still `Pending` is a person's
request to connect. A `MEMBER_FOLLOW` or `ORGANIZATION` one invites the account
to follow a member or a page: counted (`others`), never listed.

No key the data carries holds an invitation's note or when it was sent (none
in the capture): both are left out, never read off the markup. UNVERIFIED
until a capture shows one.

The list is whole (`complete`) only where the rows it keys number the page's
own count of its list, `invitationManagerReceivedRegularCount` — every type,
in the inbox shown — and the page has no other inbox: its
`invitationManagerReceivedHasSpam` is what shows "You also have invitations
in your other inbox" when it is "Yes" (`otherInbox`), and only "No" says there
is none. `invitationManagerReceivedPeopleCount` is no such count: it read 0
beside two people's requests in the capture.

FAIL CLOSED. A request this module cannot bind to exactly one sender, an
action naming no request, two requests from one member, a type or a state it
does not know, a page counting requests it keys none of, or data that shows
neither a request nor the list's count is `UI_DRIFT`, with the data's shape
fingerprint and an excerpt naming no one — never a best guess, and never "no
invitations".
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

from .invitations import INVITATIONS_PATH, MAX_DISPLAY_NAME
from .protocol import SELECTOR_PACK_VERSION, SidecarError
from .replies import profile_identity
from .thread_data import state_name

# The navigation's own response for the received list: any invitation-manager
# address but the sent list's, as LinkedIn may serve it under the manager's
# own address (read 2026-10-14).
INVITATIONS_DOCUMENT_RE = re.compile(
	r"^https://www\.linkedin\.com" + re.escape(INVITATIONS_PATH) + r"(?:/(?!sent\b)[^?#]*)?(?:[?#]|$)"
)

ROW_KEY_PREFIX = "invitation_manager_row_urn:li:invitation:"
ACTION_REQUEST = "com.linkedin.sdui.requests.mynetwork.addaInvitationAction"
SERVER_REQUEST_TYPE = "proto.sdui.actions.core.ServerRequest"
STATE_TYPE = "proto.sdui.State"
STATE_KEY_PREFIX = "invitation_action_state_"
CONNECTION = "GenericInvitationType_CONNECTION"
INVITATION_TYPES = frozenset({CONNECTION, "GenericInvitationType_MEMBER_FOLLOW", "GenericInvitationType_ORGANIZATION"})
PENDING = "Pending"
INVITATION_STATES = frozenset({PENDING, "Accepted", "Ignored", "Rejected"})
ACCEPT = "InviteeActionType_ACCEPT"
LIST_COUNT_STATE = "invitationManagerReceivedRegularCount"
OTHER_INBOX_STATE = "invitationManagerReceivedHasSpam"
# Which inbox the page shows, where it says: the received list is the focused
# one, never the other inbox's.
SELECTED_INBOX_STATE = "invitationManagerReceivedSelectedInbox"
FOCUSED_INBOX = "FOCUSED"

_INVITATION_ID_RE = re.compile(r"[0-9]{1,30}")
_PROFILE_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,200}")
# "Accept Ada Lindqvist’s invitation", as the Accept's own label says it.
_ACCEPT_LABEL_RE = re.compile(r"^Accept (.+?)(?:'s|’s) invitation$")
# A model state's own value, by its kind; an expression is no value.
_VALUE_CASES = frozenset({"stringValue", "intValue", "booleanValue"})


@dataclass(frozen=True)
class ReceivedInvitation:
	"""One person's request to connect, bound to its sender."""

	invitation_id: str
	sender_id: str
	sender_url: str
	display_name: str


@dataclass(frozen=True)
class ReceivedInvitations:
	invitations: list[ReceivedInvitation]
	# Requests that invite the account to follow a member or a page.
	others: int
	complete: bool
	# The page says the account has invitations in its other inbox.
	other_inbox: bool
	fingerprint: str


@dataclass
class _Facts:
	"""Everything the data says of one invitation id: each action's type and
	member, and the name the Accept's label carries."""

	types: set[str] = field(default_factory=set)
	members: set[str | None] = field(default_factory=set)
	accept_labels: set[str] = field(default_factory=set)


@dataclass
class _Data:
	"""What one pass over the rows gathers: the requests keyed, in order, the
	facts of each invitation id, the model states the page starts from, the
	slugs each member id is bound to, and the data's shape."""

	rows: dict[str, None] = field(default_factory=dict)
	facts: dict[str, _Facts] = field(default_factory=dict)
	states: dict[str, list[Any]] = field(default_factory=dict)
	slugs: dict[str, set[str]] = field(default_factory=dict)
	shape: set[str] = field(default_factory=set)


def received_invitations(values: list[Any]) -> ReceivedInvitations:
	"""Every person's request the page's data lists, or the failure that keeps
	the caller from changing anything."""
	data = _gather(values)
	fingerprint = hashlib.sha256("\n".join(sorted(data.shape)).encode()).hexdigest()[:16]
	states = _States(data.states, fingerprint)
	inbox = states.value(SELECTED_INBOX_STATE)
	if inbox is not None and inbox != FOCUSED_INBOX:
		raise _drift("the page shows another inbox than the received list", fingerprint, f"inbox={inbox!r}")
	count = states.value(LIST_COUNT_STATE)
	counted = count if isinstance(count, int) and not isinstance(count, bool) and count >= 0 else None
	if not data.rows and counted is None:
		raise _drift("the data shows neither a request nor the list's count", fingerprint)
	if not data.rows and counted:
		raise _drift(f"the page counts {counted} requests and keys none of them", fingerprint)
	unkeyed = [invitation_id for invitation_id in data.facts if invitation_id not in data.rows]
	if unkeyed:
		raise _drift(f"{len(unkeyed)} invitation actions name no request on the page", fingerprint)

	invitations: list[ReceivedInvitation] = []
	others = 0
	members: set[str] = set()
	for index, invitation_id in enumerate(data.rows):
		facts = data.facts.get(invitation_id, _Facts())
		status = states.value(STATE_KEY_PREFIX + invitation_id)
		excerpt = f"request {index}: types={sorted(facts.types)}, state={status!r}"
		if not _INVITATION_ID_RE.fullmatch(invitation_id) or len(facts.types) != 1 or len(facts.members) != 1:
			raise _drift(
				"a request's actions do not name one invitation of one kind from one sender", fingerprint, excerpt
			)
		[kind], [member] = facts.types, facts.members
		if kind not in INVITATION_TYPES or status not in INVITATION_STATES:
			raise _drift("a request is of a type or in a state this reader does not know", fingerprint, excerpt)
		if kind != CONNECTION:
			if status == PENDING:
				others += 1
			continue
		sender = _sender(member, data.slugs)
		if member is None or sender is None:
			raise _drift(
				"a request to connect names no member the page binds to one public profile", fingerprint, excerpt
			)
		if member in members:
			raise _drift("two requests name one sender", fingerprint, excerpt)
		members.add(member)
		if status == PENDING:
			invitations.append(_invitation(invitation_id, sender, facts.accept_labels))
	if len({invitation.sender_id for invitation in invitations}) != len(invitations):
		raise _drift("two requests name one public profile", fingerprint)
	other_inbox = states.value(OTHER_INBOX_STATE)
	return ReceivedInvitations(
		invitations=invitations,
		others=others,
		complete=counted == len(data.rows) and other_inbox == "No",
		other_inbox=other_inbox == "Yes",
		fingerprint=fingerprint,
	)


def _sender(member: str | None, slugs: dict[str, set[str]]) -> tuple[str, str] | None:
	"""(profile id, profile url) of the one public profile the page binds the
	member id to, or None where it binds none or several."""
	bound = slugs.get(member or "", set())
	if member is None or not _PROFILE_ID_RE.fullmatch(member) or len(bound) != 1:
		return None
	return profile_identity(f"/in/{quote(next(iter(bound)), safe='-_.')}/")


def _invitation(invitation_id: str, sender: tuple[str, str], accept_labels: set[str]) -> ReceivedInvitation:
	"""One request to connect: its urn in the form Engager stores, its sender,
	and the name its Accept's label carries — else the slug."""
	slug, url = sender
	names = {match.group(1).strip() for label in accept_labels if (match := _ACCEPT_LABEL_RE.fullmatch(label))}
	name = next(iter(names)) if len(names) == 1 else ""
	return ReceivedInvitation(
		invitation_id=f"urn:li:invitation:{invitation_id}",
		sender_id=slug,
		sender_url=url,
		display_name=(name or slug)[:MAX_DISPLAY_NAME],
	)


def invitations_read(
	page: ReceivedInvitations,
	*,
	limit: int,
	observed_at: int,
	session_id: str,
) -> dict[str, Any]:
	"""The wire result for one read: the requests as the page lists them, at
	most `limit`."""
	return {
		"invitations": [
			{
				"invitationId": invitation.invitation_id,
				"sender": {
					"profileId": invitation.sender_id,
					"url": invitation.sender_url,
					"displayName": invitation.display_name,
				},
				"observedAt": observed_at,
			}
			for invitation in page.invitations[:limit]
		],
		"others": page.others,
		"complete": page.complete,
		"otherInbox": page.other_inbox,
		"truncated": len(page.invitations) > limit,
		"observedAt": observed_at,
		"sessionId": session_id,
		"pageFingerprint": page.fingerprint,
		"selectorPack": SELECTOR_PACK_VERSION,
	}


class _States:
	"""The model states the page starts from, each read as one value: a key the
	data starts at two values is drift."""

	def __init__(self, states: dict[str, list[Any]], fingerprint: str) -> None:
		self._states = states
		self._fingerprint = fingerprint

	def value(self, key: str) -> Any:
		seen = self._states.get(key, [])
		if any(value != seen[0] for value in seen):
			raise _drift(f"the page starts {re.sub(r'[0-9]+', '<id>', key)} at more than one value", self._fingerprint)
		return seen[0] if seen else None


def _drift(message: str, fingerprint: str, excerpt: str = "") -> SidecarError:
	return SidecarError(
		"UI_DRIFT",
		f"the invitations page's data was not recognised: {message}",
		detail={"pageFingerprint": fingerprint, "selectorPack": SELECTOR_PACK_VERSION, "excerpt": excerpt[:300]},
	)


def _gather(values: list[Any]) -> _Data:
	"""One pass over every value the rows carry, in stream order: the requests
	keyed, each invitation action with the label of the trigger it belongs to,
	the model states the page starts from, the slug each member id is bound to,
	and the data's shape — its types and requests, nothing anyone wrote."""
	data = _Data()
	stack: list[tuple[Any, str | None]] = [(value, None) for value in reversed(values)]
	while stack:
		value, label = stack.pop()
		if isinstance(value, list):
			stack.extend((item, label) for item in reversed(value))
			continue
		if not isinstance(value, dict):
			continue
		for name in ("componentKey", "componentkey"):
			key = value.get(name)
			if isinstance(key, str) and key.startswith(ROW_KEY_PREFIX):
				data.rows.setdefault(key[len(ROW_KEY_PREFIX) :], None)
		if isinstance(value.get("$type"), str):
			data.shape.add(value["$type"])
		request = value.get("value") if value.get("$type") == SERVER_REQUEST_TYPE else None
		if isinstance(request, dict) and isinstance(request.get("requestId"), str):
			data.shape.add(request["requestId"])
			if request["requestId"] == ACTION_REQUEST:
				_keep_action(data, request, label)
		if isinstance(value.get("modelStates"), list):
			for item in value["modelStates"]:
				_keep_state(data, item)
		if (
			value.get("isVanityNameResolved") is True
			and isinstance(value.get("vanityName"), str)
			and isinstance(value.get("vieweeProfileId"), str)
		):
			data.slugs.setdefault(value["vieweeProfileId"], set()).add(value["vanityName"].strip().lower())
		# A trigger's own label belongs to the actions it lists, and to none
		# nested under another list of actions.
		inner = value.get("actionLabel") if isinstance(value.get("actions"), list) else label
		stack.extend((child, inner if isinstance(inner, str) else None) for child in reversed(list(value.values())))
	return data


def _keep_action(data: _Data, request: dict[str, Any], label: str | None) -> None:
	"""One invitation action's facts, under the invitation it names. One that
	names none is kept under no id, which no request keys."""
	arguments = request.get("requestedArguments")
	payload = arguments.get("payload") if isinstance(arguments, dict) else None
	payload = payload if isinstance(payload, dict) else {}
	urn = payload.get("invitationUrn")
	invitation_id = urn.get("invitationId") if isinstance(urn, dict) else None
	facts = data.facts.setdefault(invitation_id if isinstance(invitation_id, str) else "", _Facts())
	kind = payload.get("invitationType")
	facts.types.add(kind if isinstance(kind, str) else "")
	profile = payload.get("profileUrn")
	member = profile.get("profileId") if isinstance(profile, dict) else None
	facts.members.add(member if isinstance(member, str) else None)
	if payload.get("inviteeActionType") == ACCEPT and label is not None:
		facts.accept_labels.add(label)


def _keep_state(data: _Data, item: Any) -> None:
	"""One model state the page starts from: its key, and its value where it is
	one (an expression is kept as None)."""
	if not isinstance(item, dict) or item.get("$type") != STATE_TYPE:
		return
	name = state_name(item.get("key"))
	if name is None:
		return
	value = item.get("value")
	case = value.get("$case") if isinstance(value, dict) else None
	data.states.setdefault(name, []).append(value[case] if isinstance(value, dict) and case in _VALUE_CASES else None)
