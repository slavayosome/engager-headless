"""Where the connected account stands with one member, and the profile page a write presses on.

The read is LinkedIn's own data: who the member is, and what their controls
do, comes from the document the profile page is served as (`profile_data.py`);
where the account stands with them — the degree, an invitation either way —
from LinkedIn's relationship data for them, fetched from that page
(`member_relationship.py`), and from the document only where that did not
answer. This module turns them into the wire result — stamped with when it was
read, the browser session that read it and the document's structural
fingerprint. Nothing on the page decides a fact: no heading, class name or
label.

READ ONLY, and nothing is pressed — More included. The invitation note's
limit is LinkedIn's compose view's (`invitation_write.py`), so a read never
knows it: its note is `unknown`, and its limit null.

The page as markup is still what a write presses on. `PROFILE_SNAPSHOT_JS`
serialises it — `main`, and any dialog open beside it — and a press is bound
inside the member's top card, found by the key the page's data names
(`card_of`), never by the words on it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .member_relationship import MemberRelationship, with_relationship
from .profile_data import Own, ProfileData, profile_relationship
from .protocol import SELECTOR_PACK_VERSION, SidecarError
from .replies import Element, page_fingerprint, parse_markup, profile_identity, redacted_excerpt

# Serialises the page, where it is, and every dialog outside it — a composer
# renders in a modal outlet beside `main`, never inside it.
PROFILE_SNAPSHOT_JS = r"""() => {
  const root = document.querySelector('main') || document.body;
  return JSON.stringify({
    url: location.href,
    html: root.outerHTML,
    dialogs: [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
      .filter(dialog => !root.contains(dialog))
      .map(dialog => dialog.outerHTML)
  });
}"""

MEMBER_URL_PREFIX = "https://www.linkedin.com/in/"
# Where LinkedIn sends a member's address it will not show — deleted,
# deactivated or never there.
UNAVAILABLE_MEMBER = "unavailable"
MAX_DISPLAY_NAME = 200


@dataclass(frozen=True)
class ProfileSnapshot:
	url: str
	root: Element
	dialogs: list[Element]


def profile_snapshot_from_page(raw: Any) -> ProfileSnapshot:
	"""What PROFILE_SNAPSHOT_JS returned, or drift when it is not that shape."""
	if (
		not isinstance(raw, dict)
		or not isinstance(raw.get("url"), str)
		or not isinstance(raw.get("html"), str)
		or not isinstance(raw.get("dialogs"), list)
		or not all(isinstance(dialog, str) for dialog in raw["dialogs"])
	):
		raise SidecarError("UI_DRIFT", "the profile page could not be serialised for reading")
	return ProfileSnapshot(
		url=raw["url"],
		root=parse_markup(raw["html"]),
		dialogs=[parse_markup(dialog) for dialog in raw["dialogs"]],
	)


def member_page(url: str) -> tuple[str, str]:
	"""(public identifier, profile URL) of the member whose page this is — the
	address bar's answer, which nothing written on the page can change. Off a
	member's page, or on the address LinkedIn sends a profile it will not show,
	the profile is gone: no retry brings it back."""
	identity = profile_identity(url)
	if identity is None or not identity[1].startswith(MEMBER_URL_PREFIX) or identity[0] == UNAVAILABLE_MEMBER:
		raise SidecarError("PROFILE_UNAVAILABLE", "the profile page did not load as a member's profile")
	return identity


def card_of(snapshot: ProfileSnapshot, key: str) -> Element | None:
	"""The element the page renders the member's top card as: the one whose
	id is the card's key in the page's data (`profile_data.topcard_key`). None
	until it renders; two of them is a page this module does not know."""
	cards = [element for element in snapshot.root.iter() if element.get("id") == key]
	if len(cards) > 1:
		raise SidecarError(
			"UI_DRIFT",
			f"the profile page's structure was not recognised: {len(cards)} elements carry the top card's key",
			detail={
				"pageFingerprint": page_fingerprint(snapshot.root),
				"selectorPack": SELECTOR_PACK_VERSION,
				"excerpt": redacted_excerpt(cards[1]),
			},
		)
	return next(iter(cards), None)


def relationship_read(
	data: ProfileData,
	*,
	requested: str,
	own: Own,
	observed_at: int,
	session_id: str,
	member: MemberRelationship | None = None,
) -> dict[str, Any]:
	"""The wire result for one profile document's data, its relationship as
	LinkedIn's relationship data for the member states it where that answered
	(`member`), or the failure that keeps the caller from changing anything."""
	read = profile_relationship(data, requested=requested, own=own)
	return {
		**(with_relationship(read, member) if member is not None else read),
		"note": {"supported": "unknown", "limitChars": None},
		"observedAt": observed_at,
		"sessionId": session_id,
		"pageFingerprint": data.fingerprint,
		"selectorPack": SELECTOR_PACK_VERSION,
	}
