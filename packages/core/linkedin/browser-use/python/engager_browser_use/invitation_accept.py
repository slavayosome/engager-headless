"""Accepting one person's invitation, bound by the key the invitations page's data names for it.

Which requests are a person's, still Pending, and from whom is the page's own
data (`invitations_data.py`); this module only binds the one press. The
browser hands over the page as markup and each rule of the binding runs here,
over that string, so a synthetic row exercises it
(`tests/test_invitation_accept.py`). The page scripts below press, and press
only what a rule here named first.

What an acceptance ever presses, and nothing else:

- NOTHING before the journal holds the attempt as CLICKING. Prepare reads the
  page's data and refuses unless it lists the request — a person's request to
  connect, Pending, whose member the page binds to the sender's slug — then
  tags the one control in that request's row whose label starts "Accept",
  pressing nothing.
- that tagged control, once, after CLICKING: never the row's Ignore, never a
  Reject, never a control outside the row.

The row is the one element whose `componentkey` is
`invitation_manager_row_urn:li:invitation:<id>` — the key the data names for
the request, carried by the rendered row as by the document (read 2026-10-14).
A follow or a page's invitation is never this row: the data lists neither, so
prepare refuses before any binding.

What an acceptance came to is the sender's own profile read in the session that
pressed (`backend.py`); the row leaving the page is a wait before that read,
never a receipt.

The row's controls are as the document carries them; that a press on its
Accept accepts, with no confirmation step, is UNVERIFIED until the first real
acceptance.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from .invitations_data import ROW_KEY_PREFIX, ReceivedInvitation, ReceivedInvitations
from .protocol import SELECTOR_PACK_VERSION, SidecarError
from .replies import LABELS_JS, Element, page_fingerprint, parse_markup, redacted_excerpt

# A request's id as Engager stores it: its invitation urn.
INVITATION_URN_RE = re.compile(r"urn:li:invitation:([0-9]{1,30})")
# The row's Accept, by its words or its label: "Accept", "Accept Ada
# Lindqvist’s invitation". Handed to the page scripts, so the two bind one
# control the same way; an "Ignore …" or a Reject never reads as one.
ACCEPT_CONTROL_RE = re.compile(r"^Accept\b")
_CONTROL_ROLES = frozenset({"button"})

Refusal = Literal["invitation_not_listed"]


class Refused(Exception):
	"""An acceptance refused before anything was pressed: the request as the
	page's data showed it. Never a page fault — those are `SidecarError`s."""

	def __init__(self, reason: Refusal, detail: str | None = None) -> None:
		super().__init__(detail or reason)
		self.reason: Refusal = reason
		self.detail = detail


def row_key(invitation_id: str) -> str:
	"""The key the page's data and its rendered row name a request by."""
	match = INVITATION_URN_RE.fullmatch(invitation_id)
	if match is None:
		raise SidecarError("INVALID_REQUEST", "invitationId must be a LinkedIn invitation urn")
	return f"{ROW_KEY_PREFIX}{match.group(1)}"


def listed(page: ReceivedInvitations, *, invitation_id: str, sender_id: str) -> ReceivedInvitation | None:
	"""The one request the data lists under this id from this sender, or None.
	The list holds a person's requests still Pending alone, each from a member
	bound to one slug — a follow, a page's invitation or one answered already
	is never on it."""
	found = [
		invitation
		for invitation in page.invitations
		if invitation.invitation_id == invitation_id and invitation.sender_id == sender_id
	]
	return found[0] if len(found) == 1 else None


def admit(page: ReceivedInvitations, *, invitation_id: str, sender_id: str) -> ReceivedInvitation:
	"""Refuse unless the data lists exactly this request. Absence refuses
	whether the list is whole or not: a request not on it is never pressed."""
	invitation = listed(page, invitation_id=invitation_id, sender_id=sender_id)
	if invitation is None:
		detail = "the invitations page's data does not list this request from this sender"
		raise Refused("invitation_not_listed", detail if page.complete else f"{detail} (the list is partial)")
	return invitation


# Serialises the page and where it is. `main` holds the list; the body is the
# fallback, as the page scripts read it.
ACCEPT_SNAPSHOT_JS = r"""() => JSON.stringify({
  url: location.href,
  html: (document.querySelector('main') || document.body).outerHTML
})"""


def _of_sender(relationship: dict[str, Any] | None, sender_id: str) -> bool:
	"""A read of the sender's own page, verified in this session. No admitting
	read binds a member here, as an invitation's or a withdrawal's does
	(`invitation_write.bound_member`): the request is the sender's by the row."""
	profile = relationship.get("profile") if isinstance(relationship, dict) else None
	return isinstance(profile, dict) and profile.get("verified") is True and profile.get("id") == sender_id


def connected(relationship: dict[str, Any] | None, sender_id: str) -> bool:
	"""A read of the sender's page showing them a connection: the Accept took."""
	return _of_sender(relationship, sender_id) and relationship.get("degree") == "1st"  # type: ignore[union-attr]


def invitation_absent(relationship: dict[str, Any] | None, sender_id: str) -> bool:
	"""A read of the sender's page showing no invitation either way and no
	connection: Connect on offer, nothing pending."""
	return (
		_of_sender(relationship, sender_id)
		and relationship.get("degree") in {"2nd", "3rd+"}  # type: ignore[union-attr]
		and relationship.get("pending") == "none"  # type: ignore[union-attr]
	)


def accept_snapshot_from_page(raw: Any) -> Element:
	"""What ACCEPT_SNAPSHOT_JS returned, as markup, or drift when it is not
	that shape."""
	if not isinstance(raw, dict) or not isinstance(raw.get("url"), str) or not isinstance(raw.get("html"), str):
		raise SidecarError("UI_DRIFT", "the invitations page could not be serialised for an acceptance")
	return parse_markup(raw["html"])


def keyed_row(root: Element, key: str) -> Element | None:
	"""The one element the page keys `key`, or None while none has rendered.
	Two is drift."""
	rows = [element for element in root.iter() if element.get("componentkey") == key]
	if len(rows) > 1:
		raise _drift(f"the page keys {len(rows)} rows for one request", rows[1], page_fingerprint(root))
	return rows[0] if rows else None


def accept_control(root: Element, key: str) -> Element | None:
	"""The keyed row's one Accept, or None while the row has not rendered.
	A row offering no Accept, or more than one, is drift: nothing in it is
	pressed."""
	row = keyed_row(root, key)
	if row is None:
		return None
	controls = [element for element in row.iter() if _is_accept(element)]
	if len(controls) != 1:
		raise _drift(f"the request's row offers {len(controls)} Accept controls", row, page_fingerprint(root))
	return controls[0]


def _is_accept(element: Element) -> bool:
	"""Whether one element is an Accept control, by its words or its label."""
	if element.tag != "button" and element.get("role") not in _CONTROL_ROLES:
		return False
	labels = (element.words(), " ".join((element.get("aria-label") or "").split()))
	return any(label and ACCEPT_CONTROL_RE.search(label) for label in labels)


def bound_accept(root: Element, key: str, tag: str) -> Element:
	"""The keyed row's Accept, checked to be the one element the page script
	tagged — so what commit presses is what the rules here bound."""
	control = accept_control(root, key)
	if control is None:
		raise _drift("the request's row is gone from the page", root, page_fingerprint(root))
	tagged = [element for element in root.iter() if element.get("data-engager-accept") == tag]
	if len(tagged) != 1 or tagged[0] is not control:
		raise _drift("the tagged control is not the request's Accept", control, page_fingerprint(root))
	return control


def accept_left(root: Element, key: str) -> bool:
	"""Whether the keyed row no longer offers an Accept — gone, or answered.
	A wait after the press, never its receipt. Raises nothing: a row
	mid-transition is a page still settling."""
	rows = [element for element in root.iter() if element.get("componentkey") == key]
	return not any(_is_accept(element) for row in rows for element in row.iter())


# The page scripts. Each binds the row the way `keyed_row` does — the one
# element whose `componentkey` is the key the page's data names — and reads a
# control's label the way `Element.words` does.
_ROW_JS = r"""
  const root = document.querySelector('main') || document.body;
  const rowsOf = key => [...root.querySelectorAll('[componentkey]')].filter(element => element.getAttribute('componentkey') === key);
  const isAccept = (element, accept) =>
    (element.tagName === 'BUTTON' || element.getAttribute('role') === 'button') &&
    labels(element).some(label => accept.test(label));
"""

# Tags the keyed row's one Accept. Presses nothing.
TAG_ACCEPT_JS = (
	r"""(tag, rowKey, acceptPattern) => {"""
	+ LABELS_JS
	+ _ROW_JS
	+ r"""
  const accept = new RegExp(acceptPattern);
  const rows = rowsOf(rowKey);
  if (rows.length !== 1) return JSON.stringify({state: rows.length ? 'ambiguous' : 'no_row'});
  const controls = [...rows[0].querySelectorAll('*')].filter(element => isAccept(element, accept));
  if (controls.length !== 1) return JSON.stringify({state: controls.length ? 'ambiguous' : 'no_control'});
  controls[0].setAttribute('data-engager-accept', tag);
  return JSON.stringify({state: 'tagged'});
}"""
)

# Reads the tagged Accept, or presses it: still the one tagged, still the
# Accept inside the keyed row, enabled. `read` presses nothing.
PRESS_ACCEPT_JS = (
	r"""(tag, rowKey, acceptPattern, mode) => {"""
	+ LABELS_JS
	+ _ROW_JS
	+ r"""
  const accept = new RegExp(acceptPattern);
  const tagged = [...document.querySelectorAll('[data-engager-accept]')];
  if (tagged.length !== 1 || tagged[0].getAttribute('data-engager-accept') !== tag) {
    return JSON.stringify({state: 'control_changed'});
  }
  const control = tagged[0];
  const rows = rowsOf(rowKey);
  if (rows.length !== 1 || !rows[0].contains(control) || !isAccept(control, accept)) {
    return JSON.stringify({state: 'control_changed'});
  }
  if (control.disabled || control.getAttribute('aria-disabled') === 'true') {
    return JSON.stringify({state: 'control_disabled'});
  }
  if (mode !== 'click') return JSON.stringify({state: 'ready'});
  control.click();
  return JSON.stringify({state: 'clicked'});
}"""
)


def _drift(message: str, at: Element, fingerprint: str) -> SidecarError:
	return SidecarError(
		"UI_DRIFT",
		f"the invitations page's structure was not recognised for an acceptance: {message}",
		detail={"pageFingerprint": fingerprint, "selectorPack": SELECTOR_PACK_VERSION, "excerpt": redacted_excerpt(at)},
	)
