"""The replies under one of our comments, and the comments under a post, read from
LinkedIn's own comment data.

LinkedIn's comments endpoint answers for one comment's own thread when it is
asked by that comment's urn (`updateId`, read live 2026-10-13 on every watched
comment of a campaign): every reply to it, oldest first, each a
`com.linkedin.voyager.feed.Comment` naming our comment as its
`parentCommentUrn`, with its own `urn`, its whole words (`commentV2.text`),
when it was written (`createdTime`) and who wrote it (`commenter`, through the
`MiniProfile` in `included`, whose urn carries the member's own id) — and
`paging.total` counting them. It answers
whether or not the post's page shows our comment: on a busy post LinkedIn ranks
it out of the default view, document and markup alike, and a reader of the
page cannot find it at all. The urn is asked for exactly as stored: a ugcPost
comment's urn rebuilt in the activity spelling is refused (400).

A read that holds every reply `paging.total` counts is whole, so a reply it
does not list is missing from it as from any whole read; one such read only
marks it, and a second six hours on removes it (`replyWatches.ts`). A reply
with no words — a picture alone — is left out, and the read then proves no
absence.

It says nothing of our comment itself. The response holds the replies alone,
so who wrote the comment the urn names is not in it (`authorIsSelf` is null:
the caller's own posting receipt is what makes it ours), nor its words or its
reactions.

It does say what the signed-in account reacted to each REPLY with: beside every
reply it lists the reply's own `SocialActivityCounts`, keyed
`urn:li:fs_socialActivityCounts:<reply urn>` — `liked: true, reacted: "LIKE"`
for a reply the account liked, `liked: false, reacted: null` for one it did not
(read in the responses of 2026-10-13, 23 replies). That is the second source
for a like of a reply (`like_data.py` reads the first, the post's document).
It is read only where the counts name that reply and say one coherent thing:
anything else is no reaction read, never "not liked".

A post's own comments come from the same endpoint asked by the post's thread
reference (`feed/updatesV2`'s `updateMetadata.urn`, as `read_post_thread` asks
it), newest first where LinkedIn honours the order: the same entity, with no
parent. That is what a comment of ours is told by — written by this account,
whose words hash to ours — and what a receipt for it reads. A read is WHOLE
when it holds every comment `paging.total` counts, and only a whole read can
say a comment is not there; a read that stops short, however far it got,
proves nothing.

FAIL CLOSED. A body this module does not recognise — not a collection, no
paging, a listed comment missing or answering another comment, a reply whose
urn, words or author do not read — is VoyagerUnavailable with the response's
shape, never its words, and the caller reads the post's page as before: never
"no replies".
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

from .protocol import SELECTOR_PACK_VERSION
from .member_identity import member_urn_from_mini_profile
from .replies import MAX_DISPLAY_NAME, MAX_REPLY_TEXT, clean, comment_id, profile_identity, text_hash, utf16_len
from .voyager import VoyagerUnavailable, snowflake_id_ms

COMMENT_TYPE = "com.linkedin.voyager.feed.Comment"
# One page of a thread, and the most pages one read takes: a comment with more
# replies than that is read as far as it goes, and proves no absence.
COMMENT_DATA_PAGE = 50
COMMENT_DATA_PAGES = 3
# A post's comments read the same way: one page of them, and the most pages one
# read takes. A post with more comments than that is read as far as it goes,
# and proves no absence.
POST_COMMENT_PAGE = 50
POST_COMMENT_PAGES = 3
# The order a post's comments are asked in: newest first, so a comment posted
# a moment ago is on the first page, whatever else has been said since. The
# spelling is CHRONOLOGICAL's sibling and is UNVERIFIED live; RELEVANCE is the
# order `read_post_thread` has read in production. Which one LinkedIn answers
# to changes how far a read must go, never what a whole read says.
POST_COMMENT_ORDERS = ("REVERSE_CHRONOLOGICAL", "RELEVANCE")


def comment_data_address(comment_urn: str, start: int) -> str:
	"""The address of one page of the replies to `comment_urn`, oldest first —
	the urn as stored, every reserved character of it percent-encoded."""
	return (
		f"/voyager/api/feed/comments?count={COMMENT_DATA_PAGE}&start={start}&q=comments"
		f"&sortOrder=CHRONOLOGICAL&updateId={quote(comment_urn, safe='')}"
	)


def post_comments_address(thread_ref: str, start: int, order: str, count: int = POST_COMMENT_PAGE) -> str:
	"""The address of one page of the comments under a post, in `order` —
	`thread_ref` being the `activity:<id>` the comments are keyed by."""
	return (
		f"/voyager/api/feed/comments?count={count}&start={start}&q=comments"
		f"&sortOrder={order}&updateId={quote(thread_ref, safe='')}"
	)


@dataclass(frozen=True)
class DataComment:
	"""One comment as the data lists it — a reply to ours, or a comment on the
	post. `text` is None where it carries no words; `profile_id` and
	`profile_url` are None where its author did not resolve (a post's comments
	only), so it is never anyone's."""

	urn: str
	profile_id: str | None
	profile_url: str | None
	display_name: str | None
	member_urn: str | None
	text: str | None
	posted_at: int | None
	# The signed-in account's reaction to it as its counts state it — `Like`,
	# `Default` for none, another reaction's name — or None where they state
	# none or something incoherent.
	reaction: str | None = None
	# Whether the account may reply to it, as its socialDetail's permissions
	# state (`canPostComments`), or None where they state nothing.
	can_reply: bool | None = None


@dataclass(frozen=True)
class DataPage:
	"""One page of a thread: the comments LinkedIn counts in all, the comments
	this page listed, and the shape it came in."""

	total: int
	comments: list[DataComment]
	fingerprint: str


def comment_data_page(body: Any, comment_urn: str) -> DataPage:
	"""One page of the replies to `comment_urn`, or VoyagerUnavailable."""
	ours = comment_id(comment_urn)
	if ours is None:
		raise VoyagerUnavailable(f"{comment_urn!r} is not a comment urn")
	fingerprint, total, listed, index = _collection(body)
	replies: list[DataComment] = []
	for key in listed:
		entity = _listed_comment(index, key, fingerprint)
		parent = entity.get("parentCommentUrn")
		if not isinstance(parent, str) or comment_id(parent) != ours:
			raise _unrecognised("a listed comment answers another comment than ours", fingerprint)
		replies.append(_comment(entity, index, fingerprint))
	return DataPage(total=total, comments=replies, fingerprint=fingerprint)


def post_comments_page(body: Any) -> DataPage:
	"""One page of a post's own comments — each answering no comment — or
	VoyagerUnavailable."""
	fingerprint, total, listed, index = _collection(body)
	comments: list[DataComment] = []
	for key in listed:
		entity = _listed_comment(index, key, fingerprint)
		if entity.get("parentCommentUrn") is not None:
			raise _unrecognised("a listed comment answers another comment, not the post", fingerprint)
		comments.append(_comment(entity, index, fingerprint, anonymous=True))
	return DataPage(total=total, comments=comments, fingerprint=fingerprint)


def _collection(body: Any) -> tuple[str, int, list[str], dict[str, Any]]:
	"""(shape fingerprint, `paging.total`, the urns listed, every included
	entity by its key) of a normalized comment collection."""
	fingerprint = response_fingerprint(body)
	data = body.get("data") if isinstance(body, dict) else None
	included = body.get("included") if isinstance(body, dict) else None
	if not isinstance(data, dict) or not isinstance(included, list):
		raise _unrecognised("the response is not a normalized collection", fingerprint)
	paging = data.get("paging")
	total = paging.get("total") if isinstance(paging, dict) else None
	if isinstance(total, bool) or not isinstance(total, int) or total < 0:
		raise _unrecognised("the collection carries no paging total", fingerprint)
	listed = data.get("*elements", data.get("elements"))
	if not isinstance(listed, list) or not all(isinstance(urn, str) for urn in listed):
		raise _unrecognised("the collection lists no comment urns", fingerprint)
	index = {
		entity["entityUrn"]: entity
		for entity in included
		if isinstance(entity, dict) and isinstance(entity.get("entityUrn"), str)
	}
	return fingerprint, total, listed, index


def _listed_comment(index: dict[str, Any], key: str, fingerprint: str) -> dict[str, Any]:
	entity = index.get(key)
	if not isinstance(entity, dict) or entity.get("$type") != COMMENT_TYPE:
		raise _unrecognised("a listed comment is not in the response", fingerprint)
	return entity


def comment_data_replies(
	pages: list[DataPage],
	*,
	comment_urn: str,
	own_profile_id: str,
	since_ms: int | None,
	limit: int,
	observed_at: int,
) -> dict[str, Any]:
	"""The wire result for the pages of one read, in the order they were read.

	`replyCount` is LinkedIn's count, `replyRows` the replies read with words:
	the read proves a reply gone only where the two agree and nothing was cut
	(`provesDeletions`). `since` drops replies written before it; `limit`
	keeps the newest."""
	if not pages:
		raise VoyagerUnavailable("no page of the thread was read")
	read: dict[str, DataComment] = {}
	for page in pages:
		for reply in page.comments:
			read.setdefault(comment_id(reply.urn) or reply.urn, reply)
	total = _counted(pages)
	worded = [reply for reply in read.values() if reply.text is not None]
	replies: list[dict[str, Any]] = []
	for reply in worded:
		if since_ms is not None and reply.posted_at is not None and reply.posted_at < since_ms:
			continue
		assert reply.text is not None and reply.profile_id is not None and reply.profile_url is not None
		wire: dict[str, Any] = {
			"replyUrn": reply.urn,
			"author": {
				"profileId": reply.profile_id,
				**({"displayName": reply.display_name} if reply.display_name else {}),
				"profileUrl": reply.profile_url,
				"isSelf": reply.profile_id == own_profile_id,
				**({"memberUrn": reply.member_urn} if reply.member_urn else {}),
			},
			"text": reply.text,
			"textHash": text_hash(reply.text),
			"observedAt": observed_at,
			"isDirectChild": True,
		}
		if reply.posted_at is not None:
			wire["postedAt"] = reply.posted_at
		replies.append(wire)
	# Chronological, so `limit` keeps the newest; a reply with no time sorts as
	# the newest of all.
	replies.sort(key=lambda reply: reply.get("postedAt", float("inf")))
	return {
		"comment": {
			"present": True,
			"urn": comment_urn,
			"resolvedId": comment_urn,
			"authorIsSelf": None,
			"replyCount": total,
			"replyRows": len(worded),
			"repliesFrom": "comment_data",
		},
		"replies": replies[-limit:],
		"truncated": len(replies) > limit or len(read) < total,
		"pageFingerprint": pages[0].fingerprint,
		"selectorPack": SELECTOR_PACK_VERSION,
	}


def wants_next_page(pages: list[DataPage]) -> bool:
	"""Whether LinkedIn counts replies the pages read so far did not list, and
	the last page listed any — a page that lists none ends the read."""
	listed = sum(len(page.comments) for page in pages)
	return bool(pages) and bool(pages[-1].comments) and listed < pages[-1].total


def _counted(pages: list[DataPage]) -> int:
	"""The most any page counted: a comment withdrawn between two pages shifts
	the rest up past one nobody read, and leaves a read that looks whole."""
	return max(page.total for page in pages)


@dataclass(frozen=True)
class OwnComment:
	"""What one read of a post's comments says of a comment of ours: its urn
	where it was found, and whether the read was whole — the only read whose
	not finding it means it is not there."""

	urn: str | None
	whole: bool


def find_own_comment(
	pages: list[DataPage], *, own_profile_id: str, text: str, since_ms: int | None = None
) -> OwnComment:
	"""A comment on the post written by this account whose words are ours, in
	the pages read — written since `since_ms`, where it is given; one whose
	time does not read counts. The newest of them, should there be two."""
	if not pages:
		raise VoyagerUnavailable("no page of the post's comments was read")
	if not own_profile_id:
		raise VoyagerUnavailable("the connected account is not known")
	wanted = text_hash(clean(text))
	read: dict[str, DataComment] = {}
	for page in pages:
		for comment in page.comments:
			read.setdefault(comment_id(comment.urn) or comment.urn, comment)
	ours = [
		comment
		for comment in read.values()
		if comment.profile_id == own_profile_id
		and comment.text is not None
		and text_hash(comment.text) == wanted
		and (since_ms is None or comment.posted_at is None or comment.posted_at >= since_ms)
	]
	# One with no time sorts as the newest of all, as a reply with none does.
	newest = max(ours, key=lambda comment: float("inf") if comment.posted_at is None else comment.posted_at, default=None)
	# A comment whose author did not resolve may be ours, so it is no whole read.
	return OwnComment(
		urn=newest.urn if newest else None,
		whole=len(read) >= _counted(pages) and all(comment.profile_id is not None for comment in read.values()),
	)


def _comment(
	entity: dict[str, Any], index: dict[str, Any], fingerprint: str, *, anonymous: bool = False
) -> DataComment:
	"""A comment as a DataComment. One whose author does not resolve is an
	unrecognised response — unless `anonymous`, where it is kept with no
	profile id: counted, never anyone's, and a read holding one is not whole."""
	urn = entity.get("urn")
	if not isinstance(urn, str) or comment_id(urn) is None:
		raise _unrecognised("a comment carries no comment urn", fingerprint)
	author = _author(entity.get("commenter"), index)
	if author is None and not anonymous:
		raise _unrecognised("a comment's author does not resolve", fingerprint)
	profile_id, profile_url, display_name, member_urn = author or (None, None, None, None)
	words = entity.get("commentV2")
	raw = words.get("text") if isinstance(words, dict) else None
	if raw is not None and not isinstance(raw, str):
		raise _unrecognised("a comment's words are not text", fingerprint)
	text = clean(raw or "") or None
	if text is not None and utf16_len(text) > MAX_REPLY_TEXT:
		raise _unrecognised("a comment is longer than LinkedIn allows", fingerprint)
	created = entity.get("createdTime")
	posted_at = (
		created
		if isinstance(created, int) and not isinstance(created, bool) and created > 0
		else snowflake_id_ms(comment_id(urn) or "")
	)
	return DataComment(
		urn=urn,
		profile_id=profile_id,
		profile_url=profile_url,
		display_name=display_name,
		member_urn=member_urn,
		text=text,
		posted_at=posted_at,
		reaction=_reaction(urn, index),
		can_reply=_can_reply(entity, index),
	)


def _can_reply(entity: dict[str, Any], index: dict[str, Any]) -> bool | None:
	"""What the comment's socialDetail's permissions say of replying to it."""
	social = index.get(str(entity.get("*socialDetail")))
	permissions = index.get(str(social.get("*socialPermissions"))) if isinstance(social, dict) else None
	allowed = permissions.get("canPostComments") if isinstance(permissions, dict) else None
	return allowed if isinstance(allowed, bool) else None


# What `reacted` names, as the post's document spells the same reactions.
_REACTIONS = {
	"LIKE": "Like",
	"PRAISE": "Praise",
	"APPRECIATION": "Appreciation",
	"EMPATHY": "Empathy",
	"INTEREST": "Interest",
	"ENTERTAINMENT": "Entertainment",
}


def _reaction(comment_urn: str, index: dict[str, Any]) -> str | None:
	"""The signed-in account's reaction to the comment as the counts keyed by
	its own urn state it. `liked` and `reacted` must agree: a Like is both,
	no reaction is neither; counts that name another comment, state a reaction
	this does not know, or contradict themselves say nothing."""
	counts = index.get(f"urn:li:fs_socialActivityCounts:{comment_urn}")
	if not isinstance(counts, dict) or not str(counts.get("$type")).endswith(".SocialActivityCounts"):
		return None
	named = counts.get("urn")
	if not isinstance(named, str) or comment_id(named) != comment_id(comment_urn):
		return None
	return stated_reaction(counts)


def stated_reaction(counts: dict[str, Any]) -> str | None:
	"""The reaction one `SocialActivityCounts` states the account made — a
	post's or a comment's alike — or None where `liked` and `reacted` do not
	agree or name a reaction this does not know."""
	liked, reacted = counts.get("liked"), counts.get("reacted")
	if liked is False and reacted is None:
		return "Default"
	if reacted == "LIKE" and liked is True:
		return "Like"
	if isinstance(reacted, str) and reacted in _REACTIONS and reacted != "LIKE" and liked is not None:
		return _REACTIONS[reacted]
	return None


def data_reply_reaction(pages: list[DataPage], reply_urn: str) -> str | None:
	"""The signed-in account's reaction to one reply, from the pages read of the
	replies under its comment: the reply's own counts, found by its own id
	among the replies listed — or None where it is listed on no page or on
	two, or its counts say nothing."""
	wanted = comment_id(reply_urn)
	if wanted is None:
		return None
	found = [
		comment.reaction
		for page in pages
		for comment in page.comments
		if comment_id(comment.urn) == wanted
	]
	return found[0] if len(set(found)) == 1 else None


def _author(commenter: Any, index: dict[str, Any]) -> tuple[str, str, str | None, str | None] | None:
	"""(profile id, profile url, display name, member urn) of the member or
	company the commenter references — inline, or under its actor type's key —
	keyed as a read of the page keys the same person; a member's urn is the
	`urn:li:fsd_profile:` spelling of their mini profile's id."""
	if not isinstance(commenter, dict):
		return None
	for candidate in [commenter, *(value for value in commenter.values() if isinstance(value, dict))]:
		member = index.get(str(candidate.get("*miniProfile")))
		company = index.get(str(candidate.get("*miniCompany")))
		member_urn: str | None = None
		if isinstance(member, dict) and member.get("publicIdentifier"):
			identity = profile_identity(f"/in/{member['publicIdentifier']}/")
			name = " ".join(str(part) for part in (member.get("firstName"), member.get("lastName")) if part)
			member_urn = member_urn_from_mini_profile(member)
		elif isinstance(company, dict) and company.get("universalName"):
			identity = profile_identity(f"/company/{company['universalName']}/")
			name = str(company.get("name") or "")
		else:
			continue
		if identity is None:
			return None
		return identity[0], identity[1], clean(name)[:MAX_DISPLAY_NAME] or None, member_urn
	return None


def response_fingerprint(body: Any) -> str:
	"""A hash of the response's SHAPE — the entity types it holds and the keys a
	comment carries, with no value in it. Two pages of one layout agree."""
	tokens: set[str] = set()
	if isinstance(body, dict):
		tokens.update(f"top:{key}" for key in body)
		for entity in body.get("included") or []:
			if not isinstance(entity, dict):
				continue
			kind = str(entity.get("$type"))
			tokens.add(f"type:{kind}")
			if kind == COMMENT_TYPE:
				tokens.update(f"comment:{key}" for key in entity)
	return hashlib.sha256("\n".join(sorted(tokens)).encode()).hexdigest()[:16]


def _unrecognised(message: str, fingerprint: str) -> VoyagerUnavailable:
	return VoyagerUnavailable(f"the comment data was not recognised: {message} (shape {fingerprint})")
