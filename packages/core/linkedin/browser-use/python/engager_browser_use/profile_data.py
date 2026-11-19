"""Who a member is, and where the account stands with them, read from their profile page's own data.

The redesigned profile page is server-driven (read 2026-10-14): the document
LinkedIn serves for `/in/<member>/` carries the data the page renders from as
React flight rows, in the `#rehydrate-data` script the post page's document
carries too, and `thread_data.py` parses both. The page removes the script once
it has rendered, so the rows are read from the navigation's own response, which
the backend keeps (`_open_keeping_document`).

Only LinkedIn's semantic keys decide anything here — component keys, model
states, request payloads and tracking breadcrumbs — never a heading, a class
or a label. `<P>` is the id in the member's profile urn
(`urn:li:fsd_profile:<P>`), `<N>` the number in their member urn
(`urn:li:member:<N>`):

- the member's top card is keyed `com.linkedin.sdui.profile.card.ref<P>Topcard`;
- a request payload `{vanityName, profileId}` binds a public identifier to `<P>`;
- a payload `{vieweeProfileId, isSelfView: true}` is the viewer on their own page;
- the PROFILE_VIEW breadcrumb names `vieweeMemberUrn` and its `networkDistance`;
- the model state `profile_network_distance_<P>` is the degree, and
  `state:invitation:urn:li:member:<N>` the top card's invitation switch —
  `Connect`, `Pending` or `Withdrawn`;
- the switch's Connect, keyed `ConnectButtonstate:invitation:urn:li:member:<N>_connect`,
  either navigates to the member's invitation composer or sends an invitation
  at once (`addaAddConnection`), which nothing in Engager ever presses. A
  Connect that does anything else is `other`, and no more pressed;
- the Message button's trigger, tracked as `messageActor`, navigates to the
  compose view for the member (`dm_open.py` reads it).

A model state is read where the page declares it (`modelStates`), never from
an action that would set it: the instant Connect's own trigger sets the switch
to `Pending` on a press that has not happened.

FAIL CLOSED. Rows that do not parse, or a document with none, are
`Unrecognised`: a page the caller could not read, never an empty answer. Data
that contradicts itself — two top cards, the identifier asked for bound to
another member, two degrees, an invitation switch beside a connection — is
`UI_DRIFT`. A value this module does not know is `unknown`, never a guess.

Verified against the documents of the owner's own profile and of a 1st-degree
connection, and a live 3rd-degree profile's `Connect` (2026-10-14). `Distance2`,
`Distance3` and `OutOfNetwork`, and the switch's `Pending` and `Withdrawn`, were
seen on other members' rows or not at all, never on a top card: PARTLY VERIFIED
until the first read of such a member.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import parse_qs, unquote, urljoin, urlparse

from .protocol import SELECTOR_PACK_VERSION, SidecarError
from .thread_data import Unrecognised, flight_from_page, flight_values, script_from_document, state_name

LINKEDIN_ORIGIN = "https://www.linkedin.com"
PROFILE_URN_PREFIX = "urn:li:fsd_profile:"
# LinkedIn's invitation composer for one member: `?vanityName=<public id>`.
CUSTOM_INVITE_PATH = "/preload/custom-invite/"
# The Connect that sends an invitation at once, with no composer between.
INSTANT_CONNECT_REQUEST = "com.linkedin.sdui.requests.mynetwork.addaAddConnection"

# The id in a profile urn, as LinkedIn mints it (`ACoAA…`). An address with one
# where a public identifier would be is LinkedIn's own `/in/<P>/`, whose case
# is the id's: it is never folded. A public identifier is a member's choice of
# lowercase letters, digits and dashes, never this shape.
MEMBER_ID_RE = re.compile(r"^ACoA[A-Za-z0-9_-]{30,60}$")
_URN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
_TOPCARD_KEY_RE = re.compile(r"^com\.linkedin\.sdui\.profile\.card\.ref([A-Za-z0-9_-]{1,200})Topcard$")
_MEMBER_URN_RE = re.compile(r"^urn:li:member:([0-9]{1,20})$")
_CONNECT_KEY_RE = re.compile(r"^ConnectButtonstate:invitation:urn:li:member:([0-9]{1,20})_connect$")
MAX_DISPLAY_NAME = 200
# A switch value this module does not know, as `detail` carries it: a token,
# never words.
_STATE_TOKEN_RE = re.compile(r"[^A-Za-z0-9_]")

Degree = Literal["self", "1st", "2nd", "3rd+", "unknown"]
Pending = Literal["none", "outgoing", "unknown"]
Invitation = Literal["connect", "pending", "withdrawn"]
Connect = dict[str, str] | Literal["instant", "other", "none"]

# `profile_network_distance_<P>`. Only `Distance1` is verified on a top card.
_DEGREES: Mapping[str, Degree] = {
	"Distance1": "1st",
	"Distance2": "2nd",
	"Distance3": "3rd+",
	"OutOfNetwork": "3rd+",
}
# `state:invitation:urn:li:member:<N>`: what the switch shows, and which way an
# invitation is pending because of it. Only `Connect` is verified on a top card.
_SWITCH: Mapping[str, tuple[Invitation, Pending]] = {
	"Connect": ("connect", "none"),
	"Pending": ("pending", "outgoing"),
	"Withdrawn": ("withdrawn", "none"),
}


@dataclass(frozen=True)
class ProfileData:
	"""Every fact the document's rows declare, keyed as LinkedIn keys them —
	nothing decided yet."""

	# `<P>` of every top card the rows key.
	topcards: frozenset[str]
	# (public identifier as served, `<P>`) for every payload naming both.
	bindings: frozenset[tuple[str, str]]
	# `<P>`s and folded public identifiers a payload says are the viewer's own.
	self_ids: frozenset[str]
	self_identifiers: frozenset[str]
	# (`<N>`, network distance or None) from every PROFILE_VIEW breadcrumb.
	viewed: frozenset[tuple[str, int | None]]
	# Every declared model state's string values, by state key.
	states: Mapping[str, frozenset[str]]
	# Display names by folded public identifier, in document order.
	names: Mapping[str, tuple[str, ...]]
	# By Connect component key: the addresses it navigates to and the server
	# requests it makes.
	connects: Mapping[str, tuple[frozenset[str], frozenset[str]]]
	fingerprint: str
	# Every address a Message trigger (`messageActor`) navigates to.
	messages: frozenset[str] = frozenset()


@dataclass(frozen=True)
class Own:
	"""The connected account, as `/voyager/api/me` named it: its public
	identifier, and its profile urn's id and member number where known."""

	public_identifier: str
	urn_id: str | None = None
	member_id: str | None = None


@dataclass(frozen=True)
class OwnProfile:
	"""The connected account, as its own profile's data names it."""

	public_identifier: str
	urn_id: str
	member_id: str | None
	display_name: str | None


def document_values(document: str) -> list[Any]:
	"""Every value the document's flight rows carry, or Unrecognised."""
	values = flight_values(flight_from_page({"script": script_from_document(document)}))
	if not values:
		raise Unrecognised("the document's rehydration data holds no rows")
	return values


def profile_data(values: list[Any]) -> ProfileData:
	"""What a profile document's rows declare, in one walk."""
	topcards: set[str] = set()
	bindings: set[tuple[str, str]] = set()
	self_ids: set[str] = set()
	self_identifiers: set[str] = set()
	viewed: set[tuple[str, int | None]] = set()
	states: dict[str, set[str]] = {}
	names: dict[str, list[str]] = {}
	connects: dict[str, tuple[set[str], set[str]]] = {}
	messages: set[str] = set()
	types: set[str] = set()

	stack: list[Any] = list(reversed(values))
	while stack:
		value = stack.pop()
		if isinstance(value, list):
			stack.extend(reversed(value))
			continue
		if not isinstance(value, dict):
			continue
		stack.extend(reversed(list(value.values())))
		kind = value.get("$type")
		if isinstance(kind, str):
			types.add(kind)
		for key in _component_keys(value):
			if (card := _TOPCARD_KEY_RE.fullmatch(key)) is not None:
				topcards.add(card.group(1))
			if _CONNECT_KEY_RE.fullmatch(key) is not None:
				urls, requests = connects.setdefault(key, (set(), set()))
				_connect_actions(value, urls, requests)
		vanity, profile = value.get("vanityName"), value.get("profileId")
		# A payload naming one identifier twice binds nothing.
		if isinstance(vanity, str) and isinstance(profile, str) and _URN_ID_RE.fullmatch(profile):
			if fold(vanity) != fold(profile):
				bindings.add((vanity, profile))
		if value.get("isSelfView") is True:
			if isinstance(viewee := value.get("vieweeProfileId"), str):
				self_ids.add(viewee)
			if isinstance(vanity, str):
				self_identifiers.add(fold(vanity))
		if isinstance(vanity, str) and (name := _name(value)) is not None:
			names.setdefault(fold(vanity), []).append(name)
		if value.get("breadcrumbType") == "PROFILE_VIEW" and isinstance(content := value.get("content"), dict):
			urn = content.get("vieweeMemberUrn")
			if isinstance(urn, str) and (member := _MEMBER_URN_RE.fullmatch(urn)) is not None:
				distance = content.get("networkDistance")
				known = isinstance(distance, int) and not isinstance(distance, bool)
				viewed.add((member.group(1), distance if known else None))
		if isinstance(declared := value.get("modelStates"), list):
			for state in declared:
				if (found := _string_state(state)) is not None:
					states.setdefault(found[0], set()).add(found[1])
		tracking = value.get("tracking")
		if (
			isinstance(value.get("actions"), list)
			and isinstance(tracking, dict)
			and tracking.get("actionType") == "messageActor"
		):
			_connect_actions(value, messages, set())

	return ProfileData(
		topcards=frozenset(topcards),
		bindings=frozenset(bindings),
		self_ids=frozenset(self_ids),
		self_identifiers=frozenset(self_identifiers),
		viewed=frozenset(viewed),
		states={key: frozenset(found) for key, found in states.items()},
		names={key: tuple(found) for key, found in names.items()},
		connects={key: (frozenset(urls), frozenset(requests)) for key, (urls, requests) in connects.items()},
		fingerprint=hashlib.sha256("\n".join(sorted(types)).encode()).hexdigest()[:16],
		messages=frozenset(messages),
	)


def topcard_key(urn_id: str) -> str:
	"""The component key of the member's top card — also the id of the element
	the page renders it as (read live 2026-10-14)."""
	return f"com.linkedin.sdui.profile.card.ref{urn_id}Topcard"


def fold(identifier: str) -> str:
	"""A public identifier as it compares: decoded and case-folded, the way an
	address may spell it and a payload serve it."""
	return unquote(identifier).casefold()


def profile_relationship(data: ProfileData, *, requested: str, own: Own) -> dict[str, Any]:
	"""Who the page is, and where the account stands with them, from the
	data alone: `profile`, `degree`, `pending`, and `profileUrn`, `memberId`,
	`invitation`, `connect` and `detail` where the data names them.
	`requested` is the identifier the page was asked for — a public
	identifier, or a profile urn's id. Contradictions are `UI_DRIFT`."""
	if len(data.topcards) != 1:
		raise _drift(f"the page's data keys {len(data.topcards)} top cards", data)
	(urn_id,) = data.topcards
	asked_by_id = MEMBER_ID_RE.fullmatch(requested) is not None
	identifiers = {fold(vanity): vanity for vanity, bound in data.bindings if bound == urn_id}
	if len(identifiers) > 1:
		raise _drift(f"the member is bound to {len(identifiers)} public identifiers", data)
	if not asked_by_id and any(fold(vanity) == fold(requested) and bound != urn_id for vanity, bound in data.bindings):
		raise _drift("the identifier asked for is bound to another member", data)
	# ASSUMPTION, not a check: the PROFILE_VIEW breadcrumb names the member
	# whose top card this is. Nothing in the data ties `<N>` to `<P>` beyond
	# the two sharing a document, so `memberId` — and the invitation switch and
	# Connect keyed by it — is the breadcrumb's word for who was viewed.
	members = {member for member, _ in data.viewed}
	if len(members) > 1:
		raise _drift(f"the page's view is of {len(members)} members", data)
	member_id = next(iter(members), None)
	distances = {distance for _, distance in data.viewed if distance is not None}
	identifier = next(iter(identifiers.values()), None)

	# The page is the member asked for only where the data binds all three: the
	# top card, the public identifier and the member's number.
	asked = urn_id == requested if asked_by_id else identifier is not None and fold(identifier) == fold(requested)
	verified = asked and identifier is not None and member_id is not None
	if verified and not asked_by_id:
		profile_id = requested
	else:
		profile_id = identifier.lower() if identifier is not None else requested
	names = data.names.get(fold(identifier), ()) if identifier is not None else ()
	result: dict[str, Any] = {
		"profile": {
			"id": profile_id,
			"url": f"{LINKEDIN_ORIGIN}/in/{profile_id}/",
			"displayName": (next(iter(names), None) or profile_id)[:MAX_DISPLAY_NAME],
			"verified": verified,
		},
		"profileUrn": f"{PROFILE_URN_PREFIX}{urn_id}",
	}
	if member_id is not None:
		result["memberId"] = member_id

	if (
		urn_id in data.self_ids
		or (identifier is not None and fold(identifier) in data.self_identifiers)
		or 0 in distances
		or urn_id == own.urn_id
		or (member_id is not None and member_id == own.member_id)
		or (identifier is not None and fold(identifier) == fold(own.public_identifier))
	):
		# The account's own page: no relationship, and no Connect on it.
		return {**result, "degree": "self", "pending": "unknown", "connect": "none"}

	degree = _degree(data, urn_id, distances)
	result["degree"] = degree
	switch = _one(data, f"state:invitation:urn:li:member:{member_id}") if member_id is not None else None
	if degree == "1st":
		if switch is not None:
			raise _drift("a connection's top card carries an invitation switch", data)
		result["pending"] = "none"
	elif switch is None:
		result["pending"] = "unknown"
	elif switch in _SWITCH:
		result["invitation"], result["pending"] = _SWITCH[switch]
	else:
		result["pending"] = "unknown"
		result["detail"] = f"state:invitation={_STATE_TOKEN_RE.sub('', switch)[:64]}"
	result["connect"] = _connect(data, member_id, identifier)
	return result


def own_profile(data: ProfileData) -> OwnProfile:
	"""The connected account from its own profile's data — the page that says
	it is the viewer's own, and the identifier it binds to it — or
	Unrecognised."""
	if len(data.topcards) != 1:
		raise Unrecognised(f"the page's data keys {len(data.topcards)} top cards")
	(urn_id,) = data.topcards
	if urn_id not in data.self_ids:
		raise Unrecognised("the page's data does not say it is the viewer's own")
	identifiers = {fold(vanity): vanity for vanity, bound in data.bindings if bound == urn_id}
	if len(identifiers) != 1:
		raise Unrecognised(f"the account is bound to {len(identifiers)} public identifiers")
	(identifier,) = identifiers.values()
	own_views = {member for member, distance in data.viewed if distance == 0}
	return OwnProfile(
		public_identifier=identifier.lower(),
		urn_id=urn_id,
		member_id=next(iter(own_views)) if len(own_views) == 1 else None,
		display_name=next(iter(data.names.get(fold(identifier), ())), None),
	)


def _degree(data: ProfileData, urn_id: str, distances: set[int]) -> Degree:
	value = _one(data, f"profile_network_distance_{urn_id}")
	degree = _DEGREES.get(value, "unknown") if value is not None else "unknown"
	# The view breadcrumb says the same thing a second way, and only its
	# 1 is verified: connected there and not here, or the reverse, is drift.
	if distances and degree != "unknown" and (degree == "1st") != (distances == {1}):
		raise _drift("the page's degree and its view breadcrumb disagree", data)
	return degree


def _one(data: ProfileData, key: str) -> str | None:
	values = data.states.get(key, frozenset())
	if len(values) > 1:
		raise _drift(f"the page's data declares {len(values)} values for one state", data)
	return next(iter(values), None)


def _connect(data: ProfileData, member_id: str | None, identifier: str | None) -> Connect:
	"""What the member's Connect does: navigate to their invitation composer —
	the address it names — or send at once, or something else the data shows
	(`other`: an address that is not their composer, a request that is not the
	instant send), or nothing."""
	if member_id is None or identifier is None:
		return "none"
	key = f"ConnectButtonstate:invitation:urn:li:member:{member_id}_connect"
	urls, requests = data.connects.get(key, (frozenset(), frozenset()))
	composers: set[str] = set()
	for url in urls:
		address = urljoin(f"{LINKEDIN_ORIGIN}/", url)
		parsed = urlparse(address)
		if parsed.scheme != "https" or parsed.hostname not in {"linkedin.com", "www.linkedin.com"}:
			continue
		if parsed.path.rstrip("/") + "/" != CUSTOM_INVITE_PATH:
			continue
		named = parse_qs(parsed.query).get("vanityName", [])
		if len(named) != 1 or fold(named[0]) != fold(identifier):
			raise _drift("the member's Connect leads to another member's composer", data)
		composers.add(address)
	if len(composers) > 1:
		raise _drift(f"the member's Connect leads to {len(composers)} composers", data)
	if composers:
		return {"composerUrl": composers.pop()}
	if INSTANT_CONNECT_REQUEST in requests:
		return "instant"
	return "other" if urls or requests else "none"


def _component_keys(value: dict[str, Any]) -> list[str]:
	"""The component keys one element carries: its own, either spelling, and
	its button's."""
	button = value.get("buttonProps")
	found = [value.get("componentKey"), value.get("componentkey")]
	if isinstance(button, dict):
		found.append(button.get("componentkey"))
	return [key for key in found if isinstance(key, str)]


def _connect_actions(holder: dict[str, Any], urls: set[str], requests: set[str]) -> None:
	"""Every address the Connect navigates to and every request it makes,
	anywhere under it."""
	stack: list[Any] = [holder]
	while stack:
		value = stack.pop()
		if isinstance(value, list):
			stack.extend(value)
			continue
		if not isinstance(value, dict):
			continue
		stack.extend(value.values())
		kind = value.get("$type")
		if kind == "proto.sdui.actions.core.NavigateToUrl":
			target = value.get("urlValue")
			if isinstance(target, dict) and target.get("$case") == "url" and isinstance(target.get("url"), str):
				urls.add(target["url"])
		elif kind == "proto.sdui.actions.core.ServerRequest":
			request = value.get("value")
			if isinstance(request, dict) and isinstance(request.get("requestId"), str):
				requests.add(request["requestId"])


def _string_state(state: Any) -> tuple[str, str] | None:
	"""(key, value) of one declared model state holding a string."""
	if not isinstance(state, dict):
		return None
	name, value = state_name(state.get("key")), state.get("value")
	if name is None or not isinstance(value, dict):
		return None
	if value.get("$case") != "stringValue" or not isinstance(value.get("stringValue"), str):
		return None
	return name, value["stringValue"]


def _name(value: dict[str, Any]) -> str | None:
	"""The display name a payload names beside a public identifier."""
	for given, family in (("givenName", "familyName"), ("firstName", "lastName")):
		parts = [value.get(given), value.get(family)]
		if isinstance(parts[0], str):
			name = " ".join(" ".join(part.split()) for part in parts if isinstance(part, str) and part.strip())
			if name:
				return name[:MAX_DISPLAY_NAME]
	return None


def _drift(message: str, data: ProfileData) -> SidecarError:
	"""UI_DRIFT, with the data's structural fingerprint and counts — no id,
	identifier or name of anyone."""
	shape = (
		f"topcards={len(data.topcards)} bindings={len(data.bindings)} viewed={len(data.viewed)} "
		f"states={len(data.states)} connects={len(data.connects)}"
	)
	return SidecarError(
		"UI_DRIFT",
		f"the profile page's data was not recognised: {message}",
		detail={"pageFingerprint": data.fingerprint, "selectorPack": SELECTOR_PACK_VERSION, "excerpt": shape},
	)
