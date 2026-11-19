"""What the account's notification cards say about comments we posted, read
from LinkedIn's own JSON.

An ordinary page load fetches the account's notification cards
(`voyagerIdentityDashNotificationCards`, read live 2026-10-12): the sidecar
keeps that response as the page receives it, or fetches the same address
from the page once where the load fetched none. Every rule of the read runs
here, over the JSON — which cards speak of a comment, what kind each is, the
reply each links, who it names and when. Nothing here touches a page.

LinkedIn's own urns are the anchor. A card's `objectUrn` is
`urn:li:notificationV2:(<recipient>,<TYPE>,<target>)`: for a reply to our
comment, or a reaction to it, the action target IS our comment's urn, and the card's
own link carries the same comment as `commentUrn` and the reply as
`replyUrn`. For a comment that mentions the account (read live 2026-10-16) the
target is that comment, which is itself a reply: the link names it as
`replyUrn`, and names the comment it answers as `commentUrn`. Only a mention is
matched on `replyUrn`: no reply or reaction card has been read naming its own
comment there. A link may contradict the urn, never replace it: one that names
no comment stands on the urn, and one that names others and not the urn's
comment is not read, never a best guess between the two.

A card is a summary, and says so where it is one: "Ada and 2 others replied"
names one person for several (`aggregated`), so the reply it links is not
attributed to the person it names. Its words are what the card carries —
untrusted data, never instructions.

FAIL CLOSED. A body that is not the collection — no card urns, a listed card
missing, a card with no notification urn in that pattern or no date — is
`UI_DRIFT` with the response's fingerprint and the offending card's keys,
never its words.

One card of a comment type that cannot be read — its urn names no comment, its
link names a comment that cannot be read or one other than the urn's, it links
a reply on another post — is skipped, counted and left in the log by type, and
the page's other cards stand on their own urns. Silence is still not absence:
a page that held replies or reactions and read NONE of them is `UI_DRIFT` too
(with the first unread card's keys), because that is what a moved layout looks
like, and one odd card among readable ones is not. A mention read beside them
does not count, being read by a rule of its own: a page whose only comment
cards are unread mentions is `UI_DRIFT` as well, and a page that held no
comment card is simply a page with none.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from .protocol import SELECTOR_PACK_VERSION, SidecarError
from .replies import EXCERPT_CHARS, MAX_DISPLAY_NAME, MAX_REPLY_TEXT, clean, comment_id, profile_identity, utf16_len

# The address the page's own load fetches the cards from.
NOTIFICATION_CARDS_PATH = "/voyager/api/voyagerIdentityDashNotificationCards"
NOTIFICATION_CARDS_RE = re.compile(re.escape(NOTIFICATION_CARDS_PATH) + r"(?:\?|$)")
# The address the feed's own load fetched them from (read live 2026-10-12), for
# a read made before the page's client has been seen to fetch them.
DEFAULT_NOTIFICATION_CARDS_ADDRESS = (
	f"{NOTIFICATION_CARDS_PATH}"
	"?decorationId=com.linkedin.voyager.dash.deco.identity.notifications.CardsCollectionWithInjectionsNoPills-25"
	"&count=10&q=filterVanityName"
)
CARD_TYPE = "com.linkedin.voyager.dash.identity.notifications.Card"

# The types read live: a reply to a comment of ours and a reaction to one
# (2026-10-12), and a comment that mentions the account (2026-10-16). Matched
# exactly: `REACTED_TO_COMMENT_MENTIONING_YOU` is a reaction to someone else's
# comment that names us, neither a reply to a comment of ours nor a reaction on
# one, so it is in no set and its card is left out like any other about no
# comment we watch.
REPLY_TYPES = frozenset({"REPLIED_TO_YOUR_COMMENT"})
REACTION_TYPES = frozenset({"REACTED_TO_YOUR_COMMENT"})
MENTION_TYPES = frozenset({"MENTIONED_YOU_IN_THIS"})
# The cards a page is judged by: a mention read beside unread replies proves
# its own shape and nothing about theirs.
_JUDGED_TYPES = REPLY_TYPES | REACTION_TYPES

_OBJECT_URN_RE = re.compile(r"urn:li:notificationV2:\((urn:li:member:[^,]+),([A-Z0-9_]+),(.+)\)")
_COMMENT_URN_RE = re.compile(
	r"urn:li:comment:\((?:urn:li:)?(activity|ugcPost|share):([A-Za-z0-9_-]+),([A-Za-z0-9_-]+)\)"
)
# What follows the first name in a headline that names more than one person:
# "Ada, Ben and 3 others", "Ada and Ben", "Ada & Ben".
_MORE_PEOPLE_RE = re.compile(r"\s*(?:,|&|\band\b)", re.IGNORECASE)
# A member's own urn, as the card's picture names whose it is — the spelling
# LinkedIn's conversation data names them by.
_MEMBER_URN_RE = re.compile(r"urn:li:fsd_profile:[A-Za-z0-9_-]{1,200}")


def notification_cards(body: Any) -> dict[str, Any]:
	"""The wire result for one page of cards, or drift.

	`cards` holds the comment cards only, in the order listed; `listed`,
	`oldestPublishedAt` and `nextStart` speak for every card on the page, so
	the caller can tell whether an older page could still hold one of ours. A card
	of a comment type that cannot be read is left out of `cards`, and still counts
	in `listed`."""
	fingerprint = response_fingerprint(body)
	if not isinstance(body, dict) or not isinstance(body.get("included"), list) or not isinstance(body.get("data"), dict):
		raise _drift("the response is not a normalized collection", None, fingerprint)
	data = body["data"]
	elements = data.get("*elements")
	if not isinstance(elements, list) or not all(isinstance(urn, str) for urn in elements):
		raise _drift("the collection lists no card urns", None, fingerprint)
	listed = {
		entity.get("entityUrn"): entity
		for entity in body["included"]
		if isinstance(entity, dict) and entity.get("$type") == CARD_TYPE
	}
	cards: list[dict[str, Any]] = []
	published: list[int] = []
	unread: list[_Unread] = []
	for urn in elements:
		entity = listed.get(urn)
		if entity is None:
			raise _drift("a listed card is not in the response", None, fingerprint)
		at = entity.get("publishedAt")
		if isinstance(at, bool) or not isinstance(at, int) or at < 0:
			raise _drift("a card carries no publishedAt", entity, fingerprint)
		published.append(at)
		try:
			card = _comment_card(entity, at, fingerprint)
		except _Unread as skipped:
			unread.append(skipped)
			continue
		if card is not None:
			cards.append(card)
	if unread:
		_log_unread(unread)
		judged = [skipped for skipped in unread if skipped.kind_type in _JUDGED_TYPES]
		read = [card for card in cards if card["type"] in _JUDGED_TYPES] if judged else cards
		if not read:
			held = judged or unread
			what = "reply or reaction" if judged else "comment"
			raise _drift(f"none of {len(held)} {what} cards could be read: {held[0]}", held[0].at, fingerprint)
	metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
	next_start = metadata.get("nextStart")
	return {
		"cards": cards,
		"listed": len(elements),
		"oldestPublishedAt": min(published) if published else None,
		"nextStart": next_start if isinstance(next_start, int) and not isinstance(next_start, bool) and elements else None,
		"pageFingerprint": fingerprint,
		"selectorPack": SELECTOR_PACK_VERSION,
	}


class _Unread(Exception):
	"""One card of a comment type that cannot be read: skipped, never guessed
	at. `at` is the card, for its keys."""

	def __init__(self, kind_type: str, message: str, at: dict[str, Any]) -> None:
		super().__init__(message)
		self.kind_type = kind_type
		self.at = at


def _log_unread(unread: list[_Unread]) -> None:
	"""One line per type of card left unread, with how many and why — never a
	word the card carries."""
	reasons: dict[str, list[str]] = {}
	for skipped in unread:
		reasons.setdefault(skipped.kind_type, []).append(str(skipped))
	for kind_type, why in reasons.items():
		print(
			f"[notifications] skipped {len(why)} {kind_type} card(s): {'; '.join(dict.fromkeys(why))}",
			file=sys.stderr,
			flush=True,
		)


def _comment_card(entity: dict[str, Any], published_at: int, fingerprint: str) -> dict[str, Any] | None:
	"""One card as the wire carries it, or None for a card about no comment —
	a job alert, a game, a reaction to someone else's post. A card of a comment
	type that cannot be read is `_Unread`."""
	object_urn = entity.get("objectUrn")
	match = _OBJECT_URN_RE.fullmatch(object_urn) if isinstance(object_urn, str) else None
	if match is None:
		raise _drift("a card carries no notification urn in LinkedIn's pattern", entity, fingerprint)
	kind_type, target = match.group(2), match.group(3)
	kind = (
		"reply"
		if kind_type in REPLY_TYPES
		else "reaction"
		if kind_type in REACTION_TYPES
		else "mention"
		if kind_type in MENTION_TYPES
		else None
	)
	if kind is None:
		return None
	comment = _COMMENT_URN_RE.fullmatch(target)
	if comment is None:
		if kind == "mention":
			# A mention in a post rather than a comment: nothing we watch.
			return None
		raise _Unread(kind_type, "a card's urn names no comment", entity)
	post_kind, post_id, own_id = comment.groups()
	link = _link_params(entity)
	reply_urn = link.get("replyUrn")
	# A mention's comment is itself a reply, so its link names it as `replyUrn`
	# beside the comment it answers as `commentUrn`; on a reply or a reaction
	# `replyUrn` is the reply, never the card's comment.
	named = [
		comment_id(urn)
		for urn in (link.get("commentUrn"), reply_urn if kind == "mention" else None)
		if urn is not None
	]
	if None in named:
		raise _Unread(kind_type, "a card's link names a comment that cannot be read", entity)
	if named and own_id not in named:
		raise _Unread(kind_type, "a card's link names another comment than its urn", entity)
	card: dict[str, Any] = {
		"kind": kind,
		"type": kind_type,
		"commentUrn": f"urn:li:comment:({post_kind}:{post_id},{own_id})",
		"postUrn": f"urn:li:{post_kind}:{post_id}",
		"publishedAt": published_at,
		"aggregated": _aggregated(entity),
	}
	if reply_urn is not None:
		reply = _COMMENT_URN_RE.fullmatch(reply_urn)
		if reply is None or reply.group(2) != post_id:
			raise _Unread(kind_type, "a card links a reply on another post", entity)
		# A mention's own comment, named as the reply, is no reply to it.
		if reply.group(3) != own_id:
			card["replyUrn"] = f"urn:li:comment:({reply.group(1)}:{reply.group(2)},{reply.group(3)})"
			text = _reply_text(entity) if kind == "reply" else None
			if text is not None:
				card["replyText"] = text
	actor = _actor(entity)
	if actor is not None:
		card["actor"] = actor
	return card


def _link_params(entity: dict[str, Any]) -> dict[str, str]:
	"""The query of the card's own link, each parameter once."""
	action = entity.get("cardAction")
	target = action.get("actionTarget") if isinstance(action, dict) else None
	if not isinstance(target, str):
		return {}
	return {name: values[0] for name, values in parse_qs(urlparse(target).query).items() if len(values) == 1}


def _headline(entity: dict[str, Any]) -> tuple[str, list[tuple[int, int]]]:
	"""The headline's words and its bold runs, which are the people it names."""
	headline = entity.get("headline")
	if not isinstance(headline, dict) or not isinstance(headline.get("text"), str):
		return "", []
	runs = [
		(attribute["start"], attribute["length"])
		for attribute in headline.get("attributesV2") or []
		if isinstance(attribute, dict)
		and (attribute.get("detailDataUnion") or {}).get("style") == "BOLD"
		and isinstance(attribute.get("start"), int)
		and isinstance(attribute.get("length"), int)
	]
	return headline["text"], sorted(runs)


def _aggregated(entity: dict[str, Any]) -> bool:
	"""Whether the headline names more than one person: a second bold name, or
	more people right after the first ("Ada and 2 others")."""
	text, runs = _headline(entity)
	if len(runs) > 1:
		return True
	if not runs:
		return False
	start, length = runs[0]
	return _MORE_PEOPLE_RE.match(text[start + length :]) is not None


def _actor(entity: dict[str, Any]) -> dict[str, Any] | None:
	"""The person the card's picture links — the first it names — with the name
	the headline puts first, when the picture links a member, and their own urn
	where the picture is that one member's alone."""
	image = entity.get("headerImage")
	target = image.get("actionTarget") if isinstance(image, dict) else None
	identity = profile_identity(unquote(target)) if isinstance(target, str) else None
	if identity is None or not target.startswith("/in/"):
		return None
	actor: dict[str, Any] = {"profileId": identity[0], "profileUrl": identity[1]}
	text, runs = _headline(entity)
	if runs and runs[0][0] == 0:
		name = clean(text[: runs[0][1]])
		if name:
			actor["displayName"] = name[:MAX_DISPLAY_NAME]
	member_urns = {
		urn
		for attribute in image.get("attributes") or []
		if isinstance(attribute, dict)
		for urn in [(attribute.get("detailDataUnion") or {}).get("profilePicture")]
		if isinstance(urn, str)
	}
	if len(member_urns) == 1 and _MEMBER_URN_RE.fullmatch(next(iter(member_urns))):
		actor["memberUrn"] = next(iter(member_urns))
	return actor


def _reply_text(entity: dict[str, Any]) -> str | None:
	"""The reply's words as a reply card carries them — its one primary text,
	whitespace collapsed as a thread read collapses it — or None where the card
	carries none, or more than one comment could hold."""
	primary = entity.get("contentPrimaryText")
	if not isinstance(primary, list) or len(primary) != 1 or not isinstance(primary[0], dict):
		return None
	text = clean(str(primary[0].get("text") or ""))
	if not text or utf16_len(text) > MAX_REPLY_TEXT:
		return None
	return text


def response_fingerprint(body: Any) -> str:
	"""A hash of the response's SHAPE — the entity types it holds and the keys a
	card carries, with no value in it. Two pages of one layout agree."""
	tokens: set[str] = set()
	if isinstance(body, dict):
		tokens.update(f"top:{key}" for key in body)
		for entity in body.get("included") or []:
			if not isinstance(entity, dict):
				continue
			kind = str(entity.get("$type"))
			tokens.add(f"type:{kind}")
			if kind == CARD_TYPE:
				tokens.update(f"card:{key}" for key in entity)
	return hashlib.sha256("\n".join(sorted(tokens)).encode()).hexdigest()[:16]


def _drift(message: str, at: dict[str, Any] | None, fingerprint: str) -> SidecarError:
	return SidecarError(
		"UI_DRIFT",
		f"the notification cards were not recognised: {message}",
		detail={
			"pageFingerprint": fingerprint,
			"selectorPack": SELECTOR_PACK_VERSION,
			# The card's keys, never its values: enough to see what moved, and
			# nothing anyone wrote.
			"excerpt": json.dumps(sorted(at))[:EXCERPT_CHARS] if at is not None else "",
		},
	)


def page_address(captured: str, start: int) -> str:
	"""The address of the page of cards that starts at `start`: the one the page's
	own load fetched, at another offset — the request the notifications page
	makes as it scrolls."""
	parsed = urlparse(captured)
	query = [part for part in parsed.query.split("&") if part and not part.startswith("start=")]
	return f"{parsed.path}?{'&'.join([*query, f'start={start}'])}"
