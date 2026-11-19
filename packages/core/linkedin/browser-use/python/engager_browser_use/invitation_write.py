"""One invitation with a note, sent as LinkedIn's own client sends it.

LinkedIn's client invites a member with one POST of the invitee and the note
to its relationships API (`invitation-platform`'s
`verifyQuotaAndCreateDashRequestV2`, called by `sendInvitationByProfileId`
from the Connect button's `sendInvite`, read from its bundle 2026-10-20):
`voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2`,
its recipe `InvitationCreationResultWithInvitee` expanded to the decoration
its map names. The sidecar makes that one request from inside the page, in
the page's session, beside its CSRF token — the DM's discipline
(`dm_write.py`), applied to the invitation. Nothing is typed, focused or
pressed: neither the member's Connect nor any composer is ever touched.

What an invitation ever touches, and nothing else:

- the member's own profile, read as a relationship read reads it — where the
  account stands with them is LinkedIn's relationship data for them
  (`member_relationship.py`), held to the member the admitting read bound
  (`admit`);
- LinkedIn's compose view for the account's invitations — the GET the
  client's note box makes for its limit and the account's notes left
  (`compose_view`);
- one POST of `create_invitation_body` to `CREATE_INVITATION_PATH`, after the
  journal holds the attempt as CLICKING, carrying exactly the owner's note.

A NOTE LIMIT IS READ, never assumed: the compose view's `maxMessageLength`.
One that names none refuses the note (`note_limit_unread`) — the client's
own fallback of 300 is not LinkedIn's word — and a note longer than it is
refused before anything is sent (`note_limit`). An account with no notes
left (`creditLimitReachedPremiumUpsellSlot`) has no note to add
(`note_unavailable`); a member LinkedIn takes an invitation to only with their
email is `invitation_gated`.

The client asks nothing of a second request: an invitation has no token
LinkedIn would answer a repeat with. The journal is what stops a second POST,
and LinkedIn refuses an invitation to a member one is pending to.

What a send came to is LinkedIn's answer to that POST (`send_outcome`): the
invitation it created is the receipt; a refusal it states is the invitation
refused — the weekly limit included, which it states as a 429 its client
reads as `FUSE_LIMIT_EXCEEDED`; anything else — no answer, a timeout, a server
error, an answer this module does not read — settles nothing, and only a read
of the member does (`sent`, `never_sent`).
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Literal

from .member_relationship import MemberRelationship
from .replies import clean, text_hash, utf16_len
from .thread_data import Unrecognised

# Where LinkedIn's client POSTs an invitation: the relationships resource's
# `verifyQuotaAndCreateV2` action, its recipe expanded to the decoration the
# client's recipe map names for it.
CREATE_INVITATION_PATH = (
	"/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2"
	"&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-3"
)
# The client's compose view for the account's invitations
# (`custom-invitation-compose-view.graphql`): the note's limit and whether any
# note is left. A query id LinkedIn retires answers nothing, which refuses the
# note rather than guessing its limit.
COMPOSE_VIEW_PATH = (
	"/voyager/api/graphql?includeWebMetadata=true&variables=()"
	"&queryId=voyagerRelationshipsDashCustomInviteComposeView.017735181a1f7c5029146908a2abffa2"
)
# How long the one POST waits for LinkedIn's answer before it is uncertain.
SEND_TIMEOUT_MS = 20_000
# LinkedIn's statuses that refuse nothing: a request it timed out on, one in
# conflict with another, one too early or too many. Every other 4xx refuses
# the invitation, and nothing was created.
_UNSETTLED_STATUSES = frozenset({408, 409, 425, 429})
# The one 429 that is a refusal: the account's invitation limit, as LinkedIn
# states it (`invitation-platform`'s `isFuseLimitError`).
FUSE_LIMIT_CODE = "FUSE_LIMIT_EXCEEDED"
# The most of LinkedIn's own words a refusal keeps.
_REASON_CHARS = 300
_INVITATION_URN_RE = re.compile(r"^urn:li:fsd_invitation:([0-9]{1,30})$")

Refusal = Literal[
	"already_connected",
	"invitation_pending",
	"invitation_incoming",
	"recently_withdrawn",
	"relationship_unknown",
	"relationship_moved",
	"profile_unverified",
	"note_limit",
	"note_limit_unread",
	"note_unavailable",
	"invitation_gated",
]


class Refused(Exception):
	"""An invitation refused before anything was sent: the member as
	LinkedIn's data showed them, or a note it would not carry. Never a page
	fault — those are `SidecarError`s and say nothing about the member."""

	def __init__(self, reason: Refusal, detail: str | None = None, *, limit: int | None = None) -> None:
		super().__init__(detail or reason)
		self.reason: Refusal = reason
		self.detail = detail
		self.limit = limit


# The one POST, as the client's adapter makes it: the body as JSON, the
# headers the page it is made from names itself by (`page_visit.py`), the CSRF
# token from the session cookie, the client's `accept` and restli version.
# The status is kept before the answer is read, so an answer cut short still
# says how far it got. Never retried here.
SEND_INVITATION_JS = r"""(path, body, pageHeaders, timeoutMs) => (async () => {
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
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'content-type': 'application/json; charset=UTF-8',
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


def admit(relationship: dict[str, Any], *, profile_id: str, expected: dict[str, str]) -> None:
	"""Refuse unless the read is of this member — verified, and the same
	profile urn and member number the admitting read bound — LinkedIn's data
	shows Connect on offer with neither connection nor invitation either way,
	and they stand at the degree the admitting read showed. Anything the data
	did not show is a refusal, never a go-ahead."""
	profile = relationship.get("profile")
	if not isinstance(profile, dict) or profile.get("verified") is not True or profile.get("id") != profile_id:
		raise Refused("profile_unverified")
	bound = (expected.get("profileUrn"), expected.get("memberId"))
	if None in bound or (relationship.get("profileUrn"), relationship.get("memberId")) != bound:
		raise Refused("profile_unverified", "the page is another member than the one the admitting read bound")
	degree, pending = relationship.get("degree"), relationship.get("pending")
	if degree == "1st":
		raise Refused("already_connected")
	if pending == "outgoing":
		raise Refused("invitation_pending")
	if pending == "incoming":
		raise Refused("invitation_incoming")
	if relationship.get("invitation") == "withdrawn":
		raise Refused("recently_withdrawn", "LinkedIn takes no new invitation for three weeks after one is withdrawn")
	if degree not in {"2nd", "3rd+"} or pending != "none" or relationship.get("invitation") != "connect":
		raise Refused("relationship_unknown")
	if degree != expected.get("degree"):
		raise Refused("relationship_moved", f"LinkedIn's data shows {degree}, the admitting read {expected.get('degree')}")


def admit_member(member: MemberRelationship) -> None:
	"""Refuse a member LinkedIn takes an invitation to only with their email
	(`emailRequired`, which the client's composer asks for instead)."""
	if member.email_required:
		raise Refused("invitation_gated", "LinkedIn asks for their email to connect")


@dataclass(frozen=True)
class ComposeView:
	"""The account's invitation notes, as LinkedIn's compose view states
	them: the longest note it takes, where it names one, and whether no note
	is left to add."""

	limit: int | None
	exhausted: bool


def compose_view(payload: Any) -> ComposeView:
	"""What the compose view's answer states, or Unrecognised."""
	data = payload.get("data") if isinstance(payload, dict) else None
	inner = data.get("data") if isinstance(data, dict) else None
	views = inner.get("relationshipsDashCustomInviteComposeViewByInviter") if isinstance(inner, dict) else None
	elements = views.get("elements") if isinstance(views, dict) else None
	if not isinstance(elements, list) or len(elements) != 1 or not isinstance(elements[0], dict):
		raise Unrecognised("the compose view's answer holds no one view")
	view = elements[0]
	limit = view.get("maxMessageLength")
	known = isinstance(limit, int) and not isinstance(limit, bool) and limit > 0
	exhausted = view.get("creditLimitReachedPremiumUpsellSlot") is not None
	return ComposeView(limit=limit if known else None, exhausted=exhausted)


def admit_note(view: ComposeView, note: str) -> int:
	"""The limit LinkedIn's compose view states, when the note fits it — else
	the refusal. The note is measured as the client's note box measures it,
	in UTF-16 units."""
	if view.exhausted:
		raise Refused("note_unavailable", "the account has no note left to add")
	if view.limit is None:
		raise Refused("note_limit_unread", "LinkedIn's compose view names no note limit")
	if utf16_len(note) > view.limit:
		length = utf16_len(note)
		raise Refused("note_limit", f"the note is {length} characters; LinkedIn takes {view.limit}", limit=view.limit)
	return view.limit


def note_hash(note: str) -> str:
	"""The hash a receipt gives the note: whitespace collapsed, as a read
	gives words."""
	return text_hash(clean(note))


def create_invitation_body(*, profile_urn: str, note: str) -> dict[str, Any]:
	"""What the POST carries, as the client builds it: the invitee by their
	profile urn, and the owner's note exactly, unformatted. The recipe the
	client also passes is the path's decoration, not the body's."""
	return {"invitee": {"inviteeUnion": {"memberProfile": profile_urn}}, "customMessage": note}


def wire_body(body: dict[str, Any]) -> str:
	"""The body as the POST sends it: compact JSON, as `JSON.stringify` writes
	it."""
	return json.dumps(body, ensure_ascii=False, separators=(",", ":"))


def send_outcome(answer: Any) -> dict[str, Any]:
	"""What LinkedIn's answer to the one POST says, as SEND_INVITATION_JS
	handed it over: `confirmed` with the invitation it created
	(`created_invitation`); `blocked` with its stated refusal — a 4xx, the
	weekly limit's 429 among them, nothing created; `uncertain`, with what was
	seen, for anything else. Every one keeps a plain detail."""
	status = answer.get("status") if isinstance(answer, dict) else None
	if not isinstance(status, int) or isinstance(status, bool):
		return {"state": "uncertain", "error": "the page handed back no answer to the invitation's request"}
	if status == 0:
		failed = answer.get("error") or "no status"
		return {"state": "uncertain", "error": f"LinkedIn did not answer the invitation's request: {failed}"}
	if 200 <= status < 300:
		created = created_invitation(answer.get("body"))
		if isinstance(created, str):
			return {"state": "uncertain", "error": f"LinkedIn answered HTTP {status}, but {created}"}
		return {"state": "confirmed", "invitation": created}
	code, reason = _stated_refusal(answer.get("body"))
	said = f"HTTP {status}: {reason}" if reason else f"HTTP {status}"
	if 400 <= status < 500 and (status not in _UNSETTLED_STATUSES or (status == 429 and code == FUSE_LIMIT_CODE)):
		return {"state": "blocked", "detail": f"LinkedIn refused the invitation ({said})"}
	return {
		"state": "uncertain",
		"error": f"LinkedIn's answer settles nothing ({said})",
		**({"rateLimited": True} if status == 429 else {}),
	}


def created_invitation(body: Any) -> dict[str, Any] | str:
	"""The invitation a 2xx answer says LinkedIn created — its urn and the
	answer's shape — or, as a clause, why the answer is not one. The client
	reads the created invitation's `invitationUrn`, from the answer's value
	once its normalized wrapping is taken off."""
	try:
		parsed = json.loads(body) if isinstance(body, str) else None
	except json.JSONDecodeError:
		parsed = None
	value = parsed.get("data", parsed) if isinstance(parsed, dict) else None
	value = value.get("value", value) if isinstance(value, dict) else None
	if not isinstance(value, dict):
		return "its answer is not the invitation LinkedIn's client reads"
	urn = value.get("invitationUrn")
	named = _INVITATION_URN_RE.fullmatch(urn) if isinstance(urn, str) else None
	if named is None:
		return "its answer names no invitation"
	return {"invitationUrn": urn, "invitationId": named.group(1), "answerFingerprint": _answer_fingerprint(value)}


def invitation_receipt(created: dict[str, Any], *, note: str, sent_at: int, session_id: str) -> dict[str, Any]:
	"""What a confirmation carries: the invitation LinkedIn created, when its
	answer came back, and the note it carries, by hash."""
	return {
		"invitationUrn": created["invitationUrn"],
		"invitationId": created["invitationId"],
		"sentAt": sent_at,
		"noteHash": note_hash(note),
		"sessionId": session_id,
		"answerFingerprint": created["answerFingerprint"],
	}


def _stated_refusal(body: Any) -> tuple[str | None, str | None]:
	"""LinkedIn's code for a refusal, and its own words — the restli error's
	`serviceErrorCode`, `code` and `message`, where its answer is that JSON,
	at its top or under `data` — or None."""
	try:
		parsed = json.loads(body) if isinstance(body, str) else None
	except json.JSONDecodeError:
		return None, None
	if isinstance(parsed, dict) and isinstance(parsed.get("data"), dict):
		parsed = parsed["data"]
	if not isinstance(parsed, dict):
		return None, None
	said = [parsed.get(key) for key in ("serviceErrorCode", "code", "message")]
	parts = [
		str(value)
		for value in said
		if isinstance(value, (str, int)) and not isinstance(value, bool) and str(value).strip()
	]
	code = parsed.get("code") if isinstance(parsed.get("code"), str) else None
	return code, clean(" ".join(parts))[:_REASON_CHARS] or None


def _answer_fingerprint(value: dict[str, Any]) -> str:
	"""A hash of the answer's SHAPE — its keys — with no value in it."""
	return hashlib.sha256("\n".join(sorted(value)).encode()).hexdigest()[:16]


def bound_member(relationship: dict[str, Any] | None, profile_id: str, admitted: dict[str, Any]) -> bool:
	"""A verified read of this member — the one the admitting read bound, by
	profile urn and member number."""
	profile = relationship.get("profile") if isinstance(relationship, dict) else None
	return (
		isinstance(profile, dict)
		and profile.get("verified") is True
		and profile.get("id") == profile_id
		and isinstance(admitted.get("profileUrn"), str)
		and isinstance(admitted.get("memberId"), str)
		and relationship.get("profileUrn") == admitted["profileUrn"]  # type: ignore[union-attr]
		and relationship.get("memberId") == admitted["memberId"]  # type: ignore[union-attr]
	)


def sent(
	relationship: dict[str, Any] | None, profile_id: str, admitted: dict[str, Any], *, withdrawn: bool = False
) -> bool:
	"""A read of the member showing our invitation out: pending, or them
	connected — an acceptance faster than the read. With `withdrawn`, our
	invitation withdrawn too: it went out, and someone withdrew it since."""
	if not bound_member(relationship, profile_id, admitted):
		return False
	assert relationship is not None
	switch = relationship.get("invitation")
	return relationship.get("degree") == "1st" or switch == "pending" or (withdrawn and switch == "withdrawn")


def never_sent(relationship: dict[str, Any] | None, profile_id: str, admitted: dict[str, Any]) -> bool:
	"""A read of the member whose data states no invitation at all: Connect on
	offer, neither connected nor invited either way."""
	return (
		bound_member(relationship, profile_id, admitted)
		and relationship.get("degree") in {"2nd", "3rd+"}  # type: ignore[union-attr]
		and relationship.get("pending") == "none"  # type: ignore[union-attr]
		and relationship.get("invitation") == "connect"  # type: ignore[union-attr]
	)
