"""Whether the account reacted to a post or a comment, read from the post page's own data.

The document LinkedIn serves for a post (`thread_data.py` reads its flight
rows) declares the page's model states once, in `modelStates` (read in the
document of a post the account had liked, captured 2026-10-15):

- `reactionState-<urn>` is the reaction the account's own control starts from —
  `Default` for none, `Like`, or another reaction's name (`Praise`,
  `Appreciation`, `Empathy`, `Interest`, `Entertainment`) — and
  `confirmedReactionState-<urn>` the one LinkedIn last confirmed;
- a post's are keyed by its thread, which for an activity is the ugcPost it
  carries, never the activity the address names; a comment's by its own urn,
  `urn:li:comment:(ugcPost:<id>,<id>)`;
- `identitySwitcherActorContext-<thread>` is who the page reacts as: empty is
  the account itself.

Which ugcPost an activity carries is read from the page's own bindings for the
post — an object naming the thread (`threadUrn`) beside the update
(`updateKey`) — and from nothing else.

A REPLY's state is declared when the page is opened the way LinkedIn's own
link to the reply opens it, `?commentUrn=<the comment it answers>&replyUrn=<the
reply>` (`reply_link_query`; read in the document of a reply the account had
liked, captured 2026-10-15): the page then declares the reply's
`reactionState-urn:li:comment:(activity:<id>,<reply id>)` and its
`confirmedReactionState-…` beside the comment's own. A plain open declares the
top-level comments the page lists and no reply's. A reply is read by its own
id, exactly as any comment is.

Only a declared state is read. The same keys recur inside the reaction menu's
SetState actions, one per reaction it offers, and an action's state is what a
press would set, never what the page holds; an optimistic state counts for
nothing either.

A reply has a second source, LinkedIn's comment data (`comment_data.py`: the
reply's `SocialActivityCounts`), and `combined_reaction` puts the two together.

FAIL CLOSED. No declared state for the action target, two that disagree, an activity
the data binds to no ugcPost or to two, or a page reacting as anyone but the
account is Unrecognised — which the caller reads as "cannot tell", never as
"not liked".
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlencode

from .replies import comment_id
from .thread_data import Unrecognised, flight_from_page, flight_values, script_from_document, state_name

DEFAULT = "Default"
LIKE = "Like"

STATE_TYPE = "proto.sdui.State"
_REACTION_PREFIXES = ("reactionState-", "confirmedReactionState-")
_ACTOR_PREFIX = "identitySwitcherActorContext-"
_POST_URN_RE = re.compile(r"urn:li:(activity|ugcPost|share):(\d+)")
_THREAD_COMMENT_URN_RE = re.compile(r"urn:li:comment:\((?:activity|ugcPost|share):\d+,(\d+)\)")


@dataclass(frozen=True)
class ReactionData:
	"""The page's declared string states by key, and every (activity urn,
	ugcPost urn) pair it binds."""

	states: dict[str, frozenset[str]]
	threads: frozenset[tuple[str, str]]


def reaction_data(values: list[Any]) -> ReactionData:
	"""What the flight values declare about reactions."""
	states: dict[str, set[str]] = {}
	threads: set[tuple[str, str]] = set()
	stack: list[Any] = list(reversed(values))
	while stack:
		value = stack.pop()
		if isinstance(value, list):
			stack.extend(reversed(value))
			continue
		if not isinstance(value, dict):
			continue
		if isinstance(declared := value.get("modelStates"), list):
			for state in declared:
				if (found := _declared(state)) is not None:
					states.setdefault(found[0], set()).add(found[1])
		if (pair := _thread_pair(value)) is not None:
			threads.add(pair)
		stack.extend(reversed(list(value.values())))
	return ReactionData(
		states={key: frozenset(found) for key, found in states.items()},
		threads=frozenset(threads),
	)


def reply_link_query(parent_urn: str, reply_urn: str) -> str | None:
	"""The query of LinkedIn's own link to a reply — `commentUrn` the comment it
	answers, `replyUrn` the reply, each urn as LinkedIn spells it, fully
	percent-encoded — or None where it cannot be formed: either urn is not a
	comment urn of a post, or both name one comment. The caller then opens the
	post as it did and reads what that declares, which for a reply is nothing."""
	parent, reply = _THREAD_COMMENT_URN_RE.fullmatch(parent_urn), _THREAD_COMMENT_URN_RE.fullmatch(reply_urn)
	if parent is None or reply is None or parent.group(1) == reply.group(1):
		return None
	return urlencode({"commentUrn": parent_urn, "replyUrn": reply_urn}, quote_via=quote)


def combined_reaction(*readings: str | None) -> str | None:
	"""The reaction two sources of one account's reaction to one reply come to,
	each a reaction's name or None where it did not say: a reaction named by
	either is the answer, so a Like in either source is a Like however the other
	reads. Two different reactions named, or one source naming no reaction and
	the other nothing, cannot tell. `Default` — none — is only the answer where
	a source says it and none says anything else: a source that is silent is
	no evidence of one."""
	named = {reading for reading in readings if reading not in (None, DEFAULT)}
	if len(named) > 1:
		return None
	if named:
		return next(iter(named))
	return DEFAULT if DEFAULT in readings else None


def document_reaction(document: str, *, post_urn: str, comment_urn: str | None = None) -> str:
	"""The account's reaction to the post, or to the comment under it, in the
	document LinkedIn served for the post — or Unrecognised."""
	values = flight_values(flight_from_page({"script": script_from_document(document)}))
	return reaction_of(reaction_data(values), post_urn=post_urn, comment_urn=comment_urn)


def reaction_of(data: ReactionData, *, post_urn: str, comment_urn: str | None = None) -> str:
	"""The one reaction the data declares for the action target — the post, or the
	comment under it where `comment_urn` is given — as the account, or
	Unrecognised."""
	threads = _post_threads(data, post_urn)
	actors = {actor for thread in threads for actor in data.states.get(_ACTOR_PREFIX + thread, frozenset())}
	if actors - {""}:
		raise Unrecognised("the page reacts as an actor other than the account")
	if comment_urn is None:
		keys = [prefix + thread for prefix in _REACTION_PREFIXES for thread in threads]
	else:
		wanted = comment_id(comment_urn)
		if wanted is None:
			raise Unrecognised("the action target is not a comment urn")
		keys = [
			key
			for key in data.states
			if (urn := _reaction_urn(key)) is not None
			and urn.startswith("urn:li:comment:")
			and comment_id(urn) == wanted
		]
	found = {reaction for key in keys for reaction in data.states.get(key, frozenset())}
	if not found:
		raise Unrecognised("the page declares no reaction state for the action target")
	if len(found) > 1:
		raise Unrecognised("the page declares the action target's reaction two ways")
	(reaction,) = found
	if not reaction:
		raise Unrecognised("the page declares an empty reaction for the action target")
	return reaction


def _post_threads(data: ReactionData, post_urn: str) -> list[str]:
	"""The urns the post's states may be keyed by: its own, and the one other
	half of the one activity/ugcPost pair the data binds it in."""
	match = _POST_URN_RE.fullmatch(post_urn.strip())
	if match is None:
		raise Unrecognised("the action target post is not an activity, ugcPost or share urn")
	urn = match.group(0)
	partners = {ugc if activity == urn else activity for activity, ugc in data.threads if urn in (activity, ugc)}
	if len(partners) > 1:
		raise Unrecognised("the page binds the post to two threads")
	return [urn, *partners]


def _reaction_urn(key: str) -> str | None:
	for prefix in _REACTION_PREFIXES:
		if key.startswith(prefix):
			return key[len(prefix) :]
	return None


def _declared(state: Any) -> tuple[str, str] | None:
	"""(key, value) of one declared, non-optimistic model state holding a string."""
	if not isinstance(state, dict) or state.get("$type") != STATE_TYPE or state.get("isOptimistic") is True:
		return None
	name, value = state_name(state.get("key")), state.get("value")
	if name is None or not isinstance(value, dict):
		return None
	if value.get("$case") != "stringValue" or not isinstance(value.get("stringValue"), str):
		return None
	return name, value["stringValue"]


def _thread_pair(value: dict[str, Any]) -> tuple[str, str] | None:
	"""(activity urn, ugcPost urn) where one object names a ugcPost thread
	beside the activity update it is shown as."""
	thread = value.get("threadUrn")
	update = value.get("updateKey")
	if not isinstance(thread, dict) or not isinstance(update, dict):
		return None
	ugc = _path(thread, "threadUrnUgcPostThreadUrn", "userGeneratedContentPostUrn", "userGeneratedContentId")
	items = update.get("items")
	if not isinstance(ugc, str) or not ugc.isdigit() or not isinstance(items, list) or len(items) != 1:
		return None
	activity = _path(items[0], "feedUpdateUrn", "updateUrnActivityUrn", "activityUrn", "activityId")
	if not isinstance(activity, str) or not activity.isdigit():
		return None
	return f"urn:li:activity:{activity}", f"urn:li:ugcPost:{ugc}"


def _path(value: Any, *names: str) -> Any:
	for name in names:
		if not isinstance(value, dict):
			return None
		value = value.get(name)
	return value
