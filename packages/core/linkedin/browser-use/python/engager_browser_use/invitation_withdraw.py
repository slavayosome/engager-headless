"""Withdrawing one invitation of ours, decided over the member's profile data and the markup of what is pressed.

Where the account stands with the member is the relationship read of their
profile (`relationship.py`): a withdrawal goes ahead only where it shows our
invitation pending. What is pressed is read as markup, and each rule runs
here, over those strings, so a saved page exercises it
(`tests/fixtures/withdraw/`). The page scripts below press, and press only
what a rule here named first.

The press is bound by the key the member's DATA names, never by its words or
where it sits: the switch's Pending is keyed
`ConnectButtonstate:invitation:urn:li:member:<N>_pending`, `<N>` the member
number the read bound, and the page renders it as an element carrying that
`componentkey` — in the top card, or in a dropdown LinkedIn portals beside
`main`, which is why the whole document is searched. Under the key there must
be exactly one control.

What a withdrawal ever presses, and nothing else:

- the top card's own More, once, in prepare, and only where nothing renders
  under the Pending's key yet: it opens a menu and sends nothing;
- NOTHING else before the journal holds the attempt as CLICKING. Prepare
  tags the one keyed control, pressing nothing;
- that tagged control, once, after CLICKING. On the layouts this module knows
  it opens LinkedIn's confirmation (`WithdrawConfirmationDialog`) and
  withdraws nothing; on one it does not know it might withdraw at once, which
  is why it is pressed only where whatever follows is read and never pressed
  again;
- the confirmation's own Withdraw, once — never its Cancel, and never a
  Withdraw anywhere but in the one confirmation that names the invitation.

What a withdrawal came to is a re-read of the member's profile, in the session
that pressed — the member the admitting read bound — whose switch shows
`Withdrawn`, or back on `Connect` (`withdrawn`, `backend.py`); here is only
what the page shows right after — the confirmation gone, still open, or a
refusal LinkedIn printed.

The keyed control, the More and the confirmation are RECONSTRUCTED, not
captured: UNVERIFIED until the first real withdrawal.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

from .invitation_write import bound_member
from .protocol import SELECTOR_PACK_VERSION, SidecarError
from .relationship import ProfileSnapshot, card_of, member_page, profile_snapshot_from_page
from .replies import LABELS_JS, Element, page_fingerprint, parse_markup, redacted_excerpt

# A control a press may land on: a button, or an element that says it is one —
# a dropdown's items are menu items.
_CONTROL_ROLES = frozenset({"button", "menuitem"})
# The top card's More, by its words or its label, handed to the page script so
# the two bind one control the same way.
MORE_CONTROL_RE = re.compile(r"^more(?: actions)?$", re.IGNORECASE)
# A dialog asking to withdraw an invitation: both words, so the invitation
# composer — which names an invitation and nothing to withdraw — never is one.
_WITHDRAW_WORD_RE = re.compile(r"\bwithdraw\b", re.IGNORECASE)
_INVITATION_WORD_RE = re.compile(r"\binvitation\b", re.IGNORECASE)
# The confirmation's own Withdraw, by its words or its label.
WITHDRAW_WORDS_RE = re.compile(r"^withdraw$", re.IGNORECASE)
WITHDRAW_LABEL_RE = re.compile(r"^withdraw(?: invitation)?$", re.IGNORECASE)
# LinkedIn's refusal after Withdraw. Words LinkedIn prints, never a guess at
# what a silence means.
_REFUSED_AFTER_WITHDRAW_RE = re.compile(
	r"\bcould(?:n't|n’t| not) withdraw\b"
	r"|\bunable to withdraw\b"
	r"|\bsomething went wrong\b"
	r"|\btry again later\b",
	re.IGNORECASE,
)

# Serialises the page as PROFILE_SNAPSHOT_JS does, and every alert and toast
# on it — where LinkedIn prints a refusal after Withdraw.
INVITATION_SNAPSHOT_JS = r"""() => {
  const root = document.querySelector('main') || document.body;
  return JSON.stringify({
    url: location.href,
    html: root.outerHTML,
    dialogs: [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
      .filter(dialog => !root.contains(dialog))
      .map(dialog => dialog.outerHTML),
    alerts: [...document.querySelectorAll('[role="alert"], .artdeco-toast-item')]
      .map(alert => alert.outerHTML)
  });
}"""


@dataclass(frozen=True)
class InvitationSnapshot:
	page: ProfileSnapshot
	alerts: list[Element]


def invitation_snapshot_from_page(raw: Any) -> InvitationSnapshot:
	"""What INVITATION_SNAPSHOT_JS returned, or drift when it is not that shape."""
	if not isinstance(raw, dict) or not isinstance(raw.get("alerts"), list) or not all(
		isinstance(alert, str) for alert in raw["alerts"]
	):
		raise SidecarError("UI_DRIFT", "the invitation page could not be serialised for reading")
	page = profile_snapshot_from_page({key: raw.get(key) for key in ("url", "html", "dialogs")})
	return InvitationSnapshot(page=page, alerts=[parse_markup(alert) for alert in raw["alerts"]])


Refusal = Literal[
	"already_connected",
	"invitation_not_pending",
	"invitation_incoming",
	"relationship_unknown",
	"profile_unverified",
]


class Refused(Exception):
	"""A withdrawal refused before anything was pressed: the member as the page
	showed them. Never a page fault — those are `SidecarError`s."""

	def __init__(self, reason: Refusal, detail: str | None = None) -> None:
		super().__init__(detail or reason)
		self.reason: Refusal = reason
		self.detail = detail


def admit(relationship: dict[str, Any], *, profile_id: str) -> None:
	"""Refuse unless the read is of this member — verified, with the profile
	urn and member number the Pending's key is built from — and their data
	shows our invitation pending: their switch on `Pending`. Anything the page
	did not show is a refusal, never a go-ahead."""
	profile = relationship.get("profile")
	if not isinstance(profile, dict) or profile.get("verified") is not True or profile.get("id") != profile_id:
		raise Refused("profile_unverified")
	degree, pending, switch = relationship.get("degree"), relationship.get("pending"), relationship.get("invitation")
	if degree == "1st":
		raise Refused("already_connected")
	if pending == "incoming":
		raise Refused("invitation_incoming")
	if switch in {"connect", "withdrawn"} and pending == "none":
		raise Refused("invitation_not_pending")
	if switch != "pending" or pending != "outgoing" or degree == "self":
		raise Refused("relationship_unknown")
	if not isinstance(relationship.get("memberId"), str) or not isinstance(relationship.get("profileUrn"), str):
		raise Refused("relationship_unknown", "the member's data names no member number to key their Pending by")


def pending_key(member_id: str) -> str:
	"""The component key of the member's Pending: their invitation switch's
	`Pending`, keyed by their member number."""
	return f"ConnectButtonstate:invitation:urn:li:member:{member_id}_pending"


@dataclass(frozen=True)
class KeyedSnapshot:
	"""Every element the page renders under one component key — the outermost
	of them, wherever they sit — and every element a withdrawal tagged."""

	url: str
	keyed: list[Element]
	tagged: list[Element]


def keyed_snapshot_from_page(raw: Any) -> KeyedSnapshot:
	"""What KEYED_SNAPSHOT_JS returned, or drift when it is not that shape."""
	if (
		not isinstance(raw, dict)
		or not isinstance(raw.get("url"), str)
		or not all(isinstance(raw.get(field), list) for field in ("keyed", "tagged"))
		or not all(isinstance(html, str) for field in ("keyed", "tagged") for html in raw[field])
	):
		raise SidecarError("UI_DRIFT", "the profile page's keyed controls could not be serialised for reading")
	return KeyedSnapshot(
		url=raw["url"],
		keyed=[parse_markup(html) for html in raw["keyed"]],
		tagged=[parse_markup(html) for html in raw["tagged"]],
	)


def keyed_control(snapshot: KeyedSnapshot, member: str, key: str) -> Element | None:
	"""The one control the member's page renders under `key` — in the top card
	or in a dropdown portalled beside `main` — or None while nothing renders
	under it. The key binds it; neither its words nor where it sits do. Under
	the key, no control, or more than one, is a layout this module does not
	know."""
	if member_page(snapshot.url)[0] != member:
		raise Refused("profile_unverified", "the page is not the member's")
	if not snapshot.keyed:
		return None
	# The page script keeps what carries `key`; what is read here must carry it
	# too — each serialisation is one element, the key on it — or the structure
	# is not the one that was bound.
	for root in snapshot.keyed:
		if [element.get("componentkey") for element in root.children if isinstance(element, Element)] != [key]:
			raise _drift("an element the page serialised is not the one under the Pending's key", root, page_fingerprint(root))
	controls = [element for root in snapshot.keyed for element in root.iter() if _is_control(element)]
	if len(controls) != 1:
		at = snapshot.keyed[0]
		raise _drift(f"the page renders {len(controls)} controls under the Pending's key", at, page_fingerprint(at))
	return controls[0]


def bound_control(snapshot: KeyedSnapshot, member: str, key: str, tag: str) -> Element:
	"""The keyed control, checked to be the one element the page script
	tagged — so what commit presses is what the rules here bound."""
	control = keyed_control(snapshot, member, key)
	if control is None:
		raise SidecarError("UI_DRIFT", "the withdrawal's page structure was not recognised: the keyed Pending is gone")
	if len(snapshot.tagged) != 1 or control.get("data-engager-withdraw") != tag:
		raise _drift("the tagged control is not the member's Pending", control, page_fingerprint(control))
	return control


def more_control(snapshot: ProfileSnapshot, member: str, card_key: str) -> Element:
	"""The top card's one More — the menu the Pending may sit in, which opens
	and sends nothing — in the card the page's data keys `card_key`."""
	if member_page(snapshot.url)[0] != member:
		raise Refused("profile_unverified", "the page is not the member's")
	card = card_of(snapshot, card_key)
	fingerprint = page_fingerprint(snapshot.root)
	if card is None:
		raise _drift("the page renders no top card under the key its data names", snapshot.root, fingerprint)
	mores = [element for element in card.iter() if _is_control(element) and _labelled(element, MORE_CONTROL_RE)]
	if len(mores) != 1:
		raise _drift(
			f"nothing renders under the Pending's key, and the member's card offers {len(mores)} More controls",
			card,
			fingerprint,
		)
	return mores[0]


def _is_control(element: Element) -> bool:
	return element.tag == "button" or element.get("role") in _CONTROL_ROLES


def _labelled(element: Element, pattern: re.Pattern[str]) -> bool:
	"""Whether a control's words or label are exactly what `pattern` names."""
	labels = (element.words(), " ".join((element.get("aria-label") or "").split()))
	return any(label and pattern.fullmatch(label) for label in labels)


@dataclass(frozen=True)
class Confirmation:
	"""LinkedIn's confirmation of a withdrawal, and its one Withdraw."""

	element: Element
	withdraw: Element


def withdraw_confirmation(snapshot: InvitationSnapshot) -> Confirmation | None:
	"""The confirmation open beside the page — a dialog that asks to withdraw an
	invitation — or None while none is. Two, or one without exactly one
	Withdraw, is drift."""
	page = snapshot.page
	fingerprint = page_fingerprint(page.root)
	candidates = [dialog for dialog in page.dialogs if _asks_to_withdraw(dialog)]
	if not candidates:
		return None
	if len(candidates) > 1:
		raise _drift(f"{len(candidates)} withdraw confirmations are open", candidates[1], fingerprint)
	dialog = candidates[0]
	withdraws = withdraw_controls(dialog)
	if len(withdraws) != 1:
		raise _drift(f"the withdraw confirmation offers {len(withdraws)} Withdraw controls", dialog, fingerprint)
	return Confirmation(dialog, withdraws[0])


def _asks_to_withdraw(dialog: Element) -> bool:
	text = dialog.text()
	return bool(_WITHDRAW_WORD_RE.search(text) and _INVITATION_WORD_RE.search(text))


def withdraw_controls(dialog: Element) -> list[Element]:
	"""The confirmation's Withdraw — by its words or its label. The page script
	holds the same rule."""
	found: list[Element] = []
	for element in dialog.iter():
		if element.tag != "button":
			continue
		label = " ".join((element.get("aria-label") or "").split())
		if WITHDRAW_WORDS_RE.fullmatch(element.words()) or (label and WITHDRAW_LABEL_RE.fullmatch(label)):
			found.append(element)
	return found


AfterWithdraw = Literal["open", "closed"]


def after_withdraw(snapshot: InvitationSnapshot) -> AfterWithdraw | tuple[Literal["refused"], str]:
	"""What the page shows right after Withdraw: LinkedIn's refusal, in its own
	words, wherever it printed one; the confirmation still open; or it gone.
	Gone is not withdrawn — only the profile re-read says that."""
	for element in [*snapshot.alerts, *snapshot.page.dialogs]:
		text = element.text()
		if _REFUSED_AFTER_WITHDRAW_RE.search(text):
			return ("refused", text[:500])
	return "open" if withdraw_confirmation(snapshot) is not None else "closed"


def withdrawn(relationship: dict[str, Any] | None, profile_id: str, admitted: dict[str, Any]) -> bool:
	"""A read of the member the admitting read bound whose data shows our
	invitation gone: their switch on `Withdrawn`, or back on `Connect`."""
	return (
		bound_member(relationship, profile_id, admitted)
		and relationship.get("pending") == "none"  # type: ignore[union-attr]
		and relationship.get("invitation") in {"withdrawn", "connect"}  # type: ignore[union-attr]
	)


def still_pending(relationship: dict[str, Any] | None, profile_id: str, admitted: dict[str, Any]) -> bool:
	"""A read of the member the admitting read bound still showing their
	switch on `Pending`."""
	return (
		bound_member(relationship, profile_id, admitted)
		and relationship.get("invitation") == "pending"  # type: ignore[union-attr]
	)


def connected(relationship: dict[str, Any] | None, profile_id: str, admitted: dict[str, Any]) -> bool:
	"""A read of the member the admitting read bound showing them connected:
	the invitation was accepted, and there is nothing left to withdraw."""
	return (
		bound_member(relationship, profile_id, admitted)
		and relationship.get("degree") == "1st"  # type: ignore[union-attr]
	)


# The page scripts. Each reads a control's label the way `Element.words` does
# (`LABELS_JS`), and finds the controls under a component key the way
# `keyed_control` does: the outermost elements carrying the key anywhere in the
# document, and the controls among them and under them.
_CONTROLS_JS = (
	LABELS_JS
	+ r"""
  const isControl = element =>
    element.tagName === 'BUTTON' || ['button', 'menuitem'].includes(element.getAttribute('role'));
  const outermostKeyed = key => {
    const keyed = [...document.querySelectorAll('[componentkey]')]
      .filter(element => element.getAttribute('componentkey') === key);
    return keyed.filter(element => !keyed.some(other => other !== element && other.contains(element)));
  };
  const keyedControls = key => outermostKeyed(key).flatMap(root =>
    [root, ...root.querySelectorAll('*')].filter(isControl));
"""
)

# Serialises the outermost elements carrying `key`, wherever the page renders
# them, and every element a withdrawal tagged. Presses nothing.
KEYED_SNAPSHOT_JS = (
	r"""(key) => {"""
	+ _CONTROLS_JS
	+ r"""
  return JSON.stringify({
    url: location.href,
    keyed: outermostKeyed(key).map(element => element.outerHTML),
    tagged: [...document.querySelectorAll('[data-engager-withdraw]')].map(element => element.outerHTML)
  });
}"""
)

# Presses the top card's one More — which opens a menu and sends nothing —
# bound inside the card the page's data keys, by the rule's own words.
PRESS_MORE_JS = (
	r"""(cardKey, morePattern) => {"""
	+ _CONTROLS_JS
	+ r"""
  const more = new RegExp(morePattern, 'i');
  const fullMatch = label => { const m = label.match(more); return !!m && m[0] === label; };
  const root = document.querySelector('main') || document.body;
  const cards = [...root.querySelectorAll('[id]')].filter(element => element.id === cardKey);
  if (cards.length !== 1) return JSON.stringify({state: cards.length ? 'ambiguous' : 'no_card'});
  const mores = [...cards[0].querySelectorAll('*')].filter(isControl)
    .filter(control => labels(control).some(fullMatch));
  if (mores.length !== 1) return JSON.stringify({state: mores.length ? 'ambiguous' : 'no_control'});
  mores[0].click();
  return JSON.stringify({state: 'clicked'});
}"""
)

# Tags the one control under the Pending's key. Presses nothing.
TAG_PENDING_JS = (
	r"""(tag, key) => {"""
	+ _CONTROLS_JS
	+ r"""
  const controls = keyedControls(key);
  if (controls.length !== 1) return JSON.stringify({state: controls.length ? 'ambiguous' : 'no_control'});
  controls[0].setAttribute('data-engager-withdraw', tag);
  return JSON.stringify({state: 'tagged'});
}"""
)

# Reads the tagged control, or presses it: still the one tagged, still the
# one control under the Pending's key, enabled. `read` presses nothing.
PRESS_PENDING_JS = (
	r"""(tag, key, mode) => {"""
	+ _CONTROLS_JS
	+ r"""
  const tagged = [...document.querySelectorAll('[data-engager-withdraw]')];
  if (tagged.length !== 1 || tagged[0].getAttribute('data-engager-withdraw') !== tag) {
    return JSON.stringify({state: 'control_changed'});
  }
  const controls = keyedControls(key);
  if (controls.length !== 1 || controls[0] !== tagged[0]) return JSON.stringify({state: 'control_changed'});
  const control = tagged[0];
  if (control.disabled || control.getAttribute('aria-disabled') === 'true') {
    return JSON.stringify({state: 'control_disabled'});
  }
  if (mode !== 'click') return JSON.stringify({state: 'ready'});
  control.click();
  return JSON.stringify({state: 'clicked'});
}"""
)

# Presses the one confirmation's one Withdraw — a dialog outside `main` that
# asks to withdraw an invitation — and never its Cancel.
CONFIRM_WITHDRAW_JS = (
	r"""(wordsPattern, labelPattern) => {"""
	+ _CONTROLS_JS
	+ r"""
  const fullMatch = (pattern, label) => { const m = label.match(pattern); return !!m && m[0] === label; };
  const byWords = new RegExp(wordsPattern, 'i');
  const byLabel = new RegExp(labelPattern, 'i');
  const root = document.querySelector('main') || document.body;
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
    .filter(dialog => !root.contains(dialog))
    .filter(dialog => {
      const text = clean(dialog.innerText || dialog.textContent);
      return /\bwithdraw\b/i.test(text) && /\binvitation\b/i.test(text);
    });
  if (dialogs.length !== 1) return JSON.stringify({state: dialogs.length ? 'ambiguous' : 'no_confirmation'});
  const withdraws = [...dialogs[0].querySelectorAll('button')].filter(button =>
    fullMatch(byWords, words(button)) || fullMatch(byLabel, clean(button.getAttribute('aria-label'))));
  if (withdraws.length !== 1) return JSON.stringify({state: 'no_control'});
  if (withdraws[0].disabled || withdraws[0].getAttribute('aria-disabled') === 'true') {
    return JSON.stringify({state: 'control_disabled'});
  }
  withdraws[0].click();
  return JSON.stringify({state: 'clicked'});
}"""
)


def _drift(message: str, at: Element, fingerprint: str) -> SidecarError:
	return SidecarError(
		"UI_DRIFT",
		f"the withdrawal's page structure was not recognised: {message}",
		detail={"pageFingerprint": fingerprint, "selectorPack": SELECTOR_PACK_VERSION, "excerpt": redacted_excerpt(at)},
	)
