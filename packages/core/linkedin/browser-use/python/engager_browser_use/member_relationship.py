"""Where the account stands with one member, as LinkedIn's own relationship data states it.

The profile page's data (`profile_data.py`) binds who a member is and what
their controls do, but it states the relationship only as the top card
happens to render it: a member whose card leads with Follow carries no
`profile_network_distance_<P>` at all, so every read of them came back with
an unknown degree (journeys 7 and 31, 15–20 Oct). LinkedIn's own client reads
the relationship from its API instead, with the member's top card: the GET
`identity/dash/profiles?q=memberIdentity&memberIdentity=<member>` decorated
`WebTopCardCore` — the recipe its map names
`com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-30`, read from
the bundle 2026-10-20 (`deco-recipes`, `profile-shared/utils/tetris-api-helpers`).

The answer names one profile (`data["*elements"]`), and among `included`:

- the member's `Profile` — `entityUrn` (`urn:li:fsd_profile:<P>`),
  `publicIdentifier`, `objectUrn` (`urn:li:member:<N>`, the number the
  page keys their invitation by), `emailRequired`, and `*memberRelationship`;
- that `MemberRelationship`, whose `memberRelationshipUnion` is exactly one of
  `self`, `connection` (or `*connection`, a `Connection` beside it) and
  `noConnection`: `memberDistance` (`DISTANCE_2`, `DISTANCE_3`,
  `OUT_OF_NETWORK`) and `invitationUnion`, exactly one of `noInvitation` —
  nothing either way, Connect on offer — and `invitation` (or `*invitation`):
  `invitationType` `SENT` or `RECEIVED`, `invitationState` `PENDING` or
  `WITHDRAWN`.

The client decides from the same fields: the distance badge reads `connection`,
`self` and `noConnection.memberDistance`; the profile's Connect is offered on
`noInvitation`, and is Pending on a `SENT` invitation (`connectActionType`);
an invitation `WITHDRAWN` is one LinkedIn takes no new invitation after for a
while (`isInviteWithdrawn`). Read live 2026-10-20 for a 3rd-degree member with
nothing pending (their card leads with Follow) and for a connection; the
`invitation` branch is the bundle's: PARTLY VERIFIED until the first read of a
member with an invitation either way.

FAIL CLOSED. An answer not in this shape, or about another member than the
one asked for, is `Unrecognised` — the API said nothing this module reads of
them, and the page's own data stands. Data that contradicts itself — two
members, a union with two branches, a member the page names otherwise — is
`UI_DRIFT`. A value this module does not know is `unknown`, with its token in
`detail`, never a guess.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import quote

from .profile_data import MEMBER_ID_RE, PROFILE_URN_PREFIX, Degree, Invitation, fold
from .protocol import SELECTOR_PACK_VERSION, SidecarError
from .thread_data import Unrecognised

# The decoration LinkedIn's client asks the top card for: its recipe map's
# `WebTopCardCore`, which carries the member's relationship.
TOP_CARD_DECORATION = "com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-30"

PROFILE_TYPE = "com.linkedin.voyager.dash.identity.profile.Profile"
RELATIONSHIP_TYPE = "com.linkedin.voyager.dash.relationships.MemberRelationship"
_PROFILE_URN_RE = re.compile(r"^urn:li:fsd_profile:([A-Za-z0-9_-]{1,200})$")
_MEMBER_URN_RE = re.compile(r"^urn:li:member:([0-9]{1,20})$")
# A token LinkedIn sent that this module does not know, as `detail` carries it.
_TOKEN_RE = re.compile(r"[^A-Za-z0-9_]")

# `noConnection.memberDistance`.
_DISTANCES: dict[str, Degree] = {
	"DISTANCE_2": "2nd",
	"DISTANCE_3": "3rd+",
	"OUT_OF_NETWORK": "3rd+",
}

Pending = Literal["none", "outgoing", "incoming", "unknown"]


@dataclass(frozen=True)
class MemberRelationship:
	"""One member as LinkedIn's relationship data states them: who, by every
	id it names, and where the account stands with them."""

	profile_urn: str
	public_identifier: str
	# `<N>` of `objectUrn`, where the answer names it.
	member_id: str | None
	degree: Degree
	pending: Pending
	# What their Connect would do as the client offers it: `connect` on no
	# invitation, `pending` on ours, `withdrawn` on ours withdrawn. None where
	# there is no Connect to offer — a connection, an invitation of theirs.
	invitation: Invitation | None
	# LinkedIn asks for the member's email before it takes an invitation.
	email_required: bool
	detail: str | None
	fingerprint: str


def top_card_path(member: str) -> str:
	"""The top card's GET for a member asked for by public identifier or by
	the id in their profile urn."""
	return (
		"/voyager/api/identity/dash/profiles?q=memberIdentity"
		f"&memberIdentity={quote(member, safe='')}&decorationId={TOP_CARD_DECORATION}"
	)


def member_relationship(payload: Any, *, requested: str) -> MemberRelationship:
	"""The member the answer names, and where the account stands with them —
	or Unrecognised. `requested` is who was asked for: a public identifier,
	or a profile urn's id; an answer about anyone else says nothing of them."""
	if not isinstance(payload, dict) or not isinstance(payload.get("data"), dict):
		raise Unrecognised("the answer is not LinkedIn's normalized JSON")
	elements = payload["data"].get("*elements")
	if not isinstance(elements, list) or not elements:
		raise Unrecognised("the answer names no member")
	if len(elements) != 1:
		raise _drift(f"the answer names {len(elements)} members", _fingerprint(payload))
	index = _index(payload)
	profile = index.get(elements[0])
	if profile is None or profile.get("$type") != PROFILE_TYPE:
		raise Unrecognised("the answer holds no profile for the member it names")
	urn, identifier = profile.get("entityUrn"), profile.get("publicIdentifier")
	if not isinstance(urn, str) or _PROFILE_URN_RE.fullmatch(urn) is None or not isinstance(identifier, str):
		raise Unrecognised("the member's profile names no profile urn or public identifier")
	by_id = MEMBER_ID_RE.fullmatch(requested) is not None
	asked = urn.removeprefix(PROFILE_URN_PREFIX) == requested if by_id else fold(identifier) == fold(requested)
	if not asked:
		# LinkedIn answers an identifier a member has left for the one they
		# took: who that is stays the page's binding to settle, never this.
		raise Unrecognised("the answer names another member than the one asked for")
	number = _MEMBER_URN_RE.fullmatch(str(profile.get("objectUrn") or ""))
	relationship = index.get(profile.get("*memberRelationship"))
	if relationship is None or relationship.get("$type") != RELATIONSHIP_TYPE:
		raise Unrecognised("the member's profile carries no relationship")
	union = _one_of(relationship.get("memberRelationshipUnion"), ("self", "connection", "noConnection"), index, payload)
	if union is None:
		raise Unrecognised("the member's relationship is none of self, a connection or no connection")
	branch, value = union
	degree: Degree
	pending: Pending
	invitation: Invitation | None = None
	detail: str | None = None
	if branch == "self":
		degree, pending = "self", "unknown"
	elif branch == "connection":
		degree, pending = "1st", "none"
	else:
		distance = value.get("memberDistance")
		degree = _DISTANCES.get(distance, "unknown") if isinstance(distance, str) else "unknown"
		if degree == "unknown":
			detail = f"memberDistance={_token(distance)}"
		pending, invitation, unread = _invitation(value.get("invitationUnion"), index, payload)
		detail = detail or unread
	return MemberRelationship(
		profile_urn=urn,
		public_identifier=identifier,
		member_id=number.group(1) if number else None,
		degree=degree,
		pending=pending,
		invitation=invitation,
		email_required=profile.get("emailRequired") is True,
		detail=detail,
		fingerprint=_fingerprint(payload),
	)


def with_relationship(read: dict[str, Any], member: MemberRelationship) -> dict[str, Any]:
	"""A read of the member's page, its relationship stated by LinkedIn's own
	data: the degree, which way an invitation is pending and the Connect the
	client offers are `member`'s; who the page is stays the page's binding,
	which `member` must name the same — the same profile urn, and the same
	member number where both name one — or the two disagree on who this is,
	which is drift. The account's own page stays the page's word."""
	if read.get("profileUrn") != member.profile_urn:
		raise _drift("LinkedIn's relationship data is about another member than the page", member.fingerprint)
	if member.member_id is not None and read.get("memberId") not in (None, member.member_id):
		raise _drift("LinkedIn's relationship data and the page name the member by different numbers", member.fingerprint)
	if read.get("degree") == "self" or member.degree == "self":
		if read.get("degree") != member.degree:
			raise _drift("LinkedIn's relationship data and the page disagree on whose page this is", member.fingerprint)
		return read
	stated = {key: value for key, value in read.items() if key not in {"invitation", "detail"}}
	stated.update(degree=member.degree, pending=member.pending)
	if member.member_id is not None:
		stated["memberId"] = member.member_id
	if member.invitation is not None:
		stated["invitation"] = member.invitation
	if member.detail is not None:
		stated["detail"] = member.detail
	return stated


def _invitation(
	union: Any, index: dict[str, dict[str, Any]], payload: dict[str, Any]
) -> tuple[Pending, Invitation | None, str | None]:
	"""Which way an invitation is pending, the Connect the client offers, and
	the token of anything this module does not know."""
	found = _one_of(union, ("noInvitation", "invitation"), index, payload)
	if found is None:
		return "unknown", None, "invitationUnion=none"
	branch, value = found
	if branch == "noInvitation":
		return "none", "connect", None
	kind, state = value.get("invitationType"), value.get("invitationState")
	if kind == "SENT" and state == "PENDING":
		return "outgoing", "pending", None
	if kind == "SENT" and state == "WITHDRAWN":
		return "none", "withdrawn", None
	if kind == "RECEIVED" and state == "PENDING":
		return "incoming", None, None
	return "unknown", None, f"invitation={_token(kind)}:{_token(state)}"


def _one_of(
	union: Any, branches: tuple[str, ...], index: dict[str, dict[str, Any]], payload: dict[str, Any]
) -> tuple[str, dict[str, Any]] | None:
	"""The one branch a union holds — inline, or by `*` reference to an entity
	beside it — or None where it holds none this module knows. Two is drift."""
	if not isinstance(union, dict):
		return None
	held: list[tuple[str, dict[str, Any]]] = []
	for branch in branches:
		value = union.get(branch)
		if value is None and isinstance(reference := union.get(f"*{branch}"), str):
			value = index.get(reference)
		if isinstance(value, dict):
			held.append((branch, value))
	if len(held) > 1:
		raise _drift(f"a relationship union holds {len(held)} branches", _fingerprint(payload))
	return held[0] if held else None


def _index(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
	return {
		entity["entityUrn"]: entity
		for entity in payload.get("included") or []
		if isinstance(entity, dict) and isinstance(entity.get("entityUrn"), str)
	}


def _token(value: Any) -> str:
	return _TOKEN_RE.sub("", str(value))[:64] or "none"


def _fingerprint(payload: dict[str, Any]) -> str:
	"""A hash of the answer's SHAPE — the types it includes — with no value."""
	types = sorted({str(entity.get("$type")) for entity in payload.get("included") or [] if isinstance(entity, dict)})
	return hashlib.sha256("\n".join(types).encode()).hexdigest()[:16]


def _drift(message: str, fingerprint: str) -> SidecarError:
	"""UI_DRIFT, with the answer's shape fingerprint — no id or name of anyone."""
	return SidecarError(
		"UI_DRIFT",
		f"LinkedIn's relationship data was not recognised: {message}",
		detail={"pageFingerprint": fingerprint, "selectorPack": SELECTOR_PACK_VERSION, "excerpt": ""},
	)
