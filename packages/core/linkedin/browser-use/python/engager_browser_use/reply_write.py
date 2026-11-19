"""The reply write: one reply of ours under a reply to one of our comments.

`prepare_write`, `commit_write` and `reconcile_posted` take a `kind: "reply"`
input naming the post, the comment of ours the reply sits under
(`parentCommentUrn`) and the reply it answers (`replyToUrn`). LinkedIn threads
are two levels deep: an answer to a reply under our comment is posted beside
that reply, as a direct reply of our comment. So the parent every check here
names is our comment, and the reply being answered is checked to stand beside
where ours will.

The reply is written as LinkedIn's own client writes one (`comment_write.py`):
one POST into our comment's thread, carrying exactly the owner's words — no
mention is added, so what LinkedIn will show of it, its BODY, is those words.
Every rule here runs over LinkedIn's comment data (`comment_data.py`), never
the page's markup: our comment, still under the post and still this account's,
read from the post's comments (`reply_parent`); the reply being answered,
directly under it and written by someone else, read from the comment's own
replies (`check_reply_target`).

FAIL CLOSED. An action target that is gone is `REPLY_TARGET_UNAVAILABLE`; a read that
stopped short of it is `THREAD_INCOMPLETE`, which proves nothing. After the
POST the receipt is LinkedIn's answer naming the reply it created, or a
re-read of the thread showing a direct reply of our comment, written by this
account, whose words hash to the body — and that was not there when the
attempt was prepared. Two identical short replies of ours under one comment
("Thanks!" to one person yesterday, to another today) are told apart by that
alone, so prepare records our replies already under the comment and the
journal keeps them beside the attempt; with no prepared attempt there is
nothing of ours to adopt. A read that could not finish proves nothing either
way, so reconciliation answers "not posted" only from a whole read of
LinkedIn's comment data; the page's markup, read where the data does not
answer, can find a reply and never deny one.
"""

from __future__ import annotations

from typing import Any

from .comment_data import DataComment, DataPage
from .protocol import SidecarError
from .replies import clean, comment_id, text_hash

# The most replies one read of the thread returns — the wire's own bound.
REPLY_READ_LIMIT = 100


def reply_parent(pages: list[DataPage], parent_urn: str, *, own_profile_id: str | None) -> DataComment:
	"""The comment a reply goes under, from LinkedIn's comment data for the
	post: still under it, open to replies, and — where `own_profile_id` is
	given, for a reply under our own comment — written by this account. A
	comment a read that stopped short did not reach is unknown, never gone."""
	wanted = comment_id(parent_urn)
	found = [comment for page in pages for comment in page.comments if comment_id(comment.urn) == wanted]
	if not found:
		seen = {comment_id(comment.urn) for page in pages for comment in page.comments}
		if not pages or len(seen) < max(page.total for page in pages):
			raise SidecarError("THREAD_INCOMPLETE", "the read did not reach the comment the reply goes under", retryable=True)
		raise _unavailable("the comment it goes under is no longer under the post")
	if own_profile_id is not None and any(comment.profile_id != own_profile_id for comment in found):
		raise _unavailable("the comment the reply would sit under is not this account's")
	if any(comment.can_reply is False for comment in found):
		raise SidecarError("COMMENTS_CLOSED", "LinkedIn does not let the account reply to the comment")
	return found[0]


def check_reply_target(read: dict[str, Any], reply_to_urn: str, room_reply_urn: str | None = None) -> dict[str, Any]:
	"""The reply being answered, from a read of the replies under the comment
	— whose author `reply_parent` holds to this account: that reply directly
	under it, written by someone else; in a room's thread, our confirmed room
	reply still there and the reply answered newer than it."""
	comment = read["comment"]
	if not comment["present"]:
		raise _unavailable("our comment is no longer under the post")
	if room_reply_urn is not None:
		if not any(reply["author"]["isSelf"] and reply.get("isDirectChild")
			and comment_id(reply["replyUrn"]) == comment_id(room_reply_urn) for reply in read["replies"]):
			raise _unavailable("our confirmed room reply is no longer in this thread")
		answered_id, ours_id = comment_id(reply_to_urn) or "", comment_id(room_reply_urn) or ""
		if not answered_id.isdecimal() or not ours_id.isdecimal() or int(answered_id) <= int(ours_id):
			raise _unavailable("the reply being answered is not newer than our room reply")
	elif comment.get("authorIsSelf") is False:
		raise _unavailable("the comment the reply would sit under is not this account's")
	answered = next(
		(reply for reply in read["replies"] if comment_id(reply["replyUrn"]) == comment_id(reply_to_urn)),
		None,
	)
	if answered is None:
		if read["truncated"]:
			raise SidecarError(
				"THREAD_INCOMPLETE", "more replies stand under our comment than one read returns", retryable=True
			)
		raise _unavailable("the reply it answers is no longer under our comment")
	if answered["author"]["isSelf"]:
		raise _unavailable("the reply it answers is this account's own")
	if not answered.get("isDirectChild"):
		raise _unavailable("the reply it answers is not directly in this thread")
	return answered


def own_reply_urns(read: dict[str, Any]) -> list[str]:
	"""Our replies already under our comment — the attempt's evidence of what
	was there before it, which no later receipt may be. A read `limit` cut
	could leave one out, so it is no evidence."""
	if read["truncated"]:
		raise SidecarError(
			"THREAD_INCOMPLETE", "more replies stand under our comment than one read returns", retryable=True
		)
	return [reply["replyUrn"] for reply in read["replies"] if reply["author"]["isSelf"]]


def own_reply(read: dict[str, Any], prepared: dict[str, Any]) -> str | None:
	"""This attempt's reply in one read of the thread: a direct reply of our
	comment, written by this account, whose words hash to the prepared body,
	and not one of ours that was already there when the attempt was prepared.
	The newest of them, should there be two — the read lists replies oldest
	first."""
	body = text_hash(clean(prepared["body"]))
	earlier = {comment_id(urn) for urn in prepared["ownReplyUrns"]}
	matches = [
		reply
		for reply in read["replies"]
		if reply["isDirectChild"]
		and reply["author"]["isSelf"]
		and reply["textHash"] == body
		and comment_id(reply["replyUrn"]) not in earlier
	]
	return matches[-1]["replyUrn"] if matches else None


def reconciled_reply(read: dict[str, Any], prepared: dict[str, Any]) -> str | None:
	"""What a read of the thread says of a prepared attempt: its reply's urn,
	or None. Only LinkedIn's comment data can say None, and only because its
	read was whole — a read `limit` cut is no evidence. The page's markup finds
	a reply and never denies one: a layout can hide what it holds, so a thread
	read as markup that does not show the reply raises instead."""
	urn = own_reply(read, prepared)
	if urn is not None:
		return urn
	if read["comment"].get("repliesFrom") != "comment_data":
		raise SidecarError(
			"THREAD_UNAVAILABLE",
			"LinkedIn's comment data did not answer, and the page alone proves no reply is missing",
			retryable=True,
		)
	if read["truncated"]:
		raise SidecarError(
			"THREAD_INCOMPLETE", "more replies stand under our comment than one read returns", retryable=True
		)
	return None


def reply_denied(read: dict[str, Any], prepared: dict[str, Any]) -> bool:
	"""Whether a read of LinkedIn's comment data shows a prepared attempt's reply
	is not under our comment, where the page told the attempt's evidence of what
	stood before it: a whole read in which no reply of ours says the prepared
	words, bar the earlier ones the attempt names. Denial is safe where adoption
	is not: any other such reply the data lists may be an earlier identical one
	the page hid, so it is neither the receipt nor a reason to deny, and the
	attempt stays uncertain."""
	if read["comment"].get("repliesFrom") != "comment_data" or read["truncated"]:
		return False
	return own_reply(read, prepared) is None


def _unavailable(message: str) -> SidecarError:
	return SidecarError("REPLY_TARGET_UNAVAILABLE", f"the reply cannot be written: {message}")
