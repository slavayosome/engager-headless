"""A public reply directly under a third party's top-level comment.

The ordinary reply arm still requires our own root comment. These rules bind
a separate room target to provider member identity, read from LinkedIn's
comment data with no name-based selection; the reply itself is one POST into
the comment's thread, as any reply's (`comment_write.py`). The service owns
the journal/token/account boundary; this module never performs a browser
action.
"""

from __future__ import annotations

from typing import Any

from .comment_data import DataComment, DataPage
from .protocol import SidecarError
from .replies import comment_id
from .reply_write import reconciled_reply


def check_room_parent(pages: list[DataPage], input_value: dict[str, Any], own_profile_id: str) -> DataComment:
	"""The parent from a read scoped to the prepared post. Missing in a partial
	read is unknown, not a new target. Duplicate conflicting identities refuse."""
	wanted = comment_id(input_value["parentCommentUrn"])
	if wanted is None:
		raise SidecarError("ROOM_TARGET_MOVED", "the parent is not a LinkedIn comment")
	parents = [comment for page in pages for comment in page.comments if comment_id(comment.urn) == wanted]
	if not parents:
		seen = {comment_id(comment.urn) for page in pages for comment in page.comments}
		if not pages or len(seen) < max(page.total for page in pages):
			raise SidecarError("THREAD_INCOMPLETE", "the read did not reach the selected room comment", retryable=True)
		raise SidecarError("ROOM_TARGET_MOVED", "the selected comment is no longer under this post")
	for parent in parents:
		if not parent.profile_id or not parent.member_urn:
			raise SidecarError("ROOM_IDENTITY_UNRESOLVED", "the parent comment's author identity did not resolve")
		if parent.profile_id == own_profile_id:
			raise SidecarError("ROOM_ALREADY_OURS", "a room reply cannot target this account's own comment")
		if parent.member_urn != input_value["expectedAuthorMemberUrn"]:
			raise SidecarError("ROOM_AUTHOR_CHANGED", "the parent no longer names the expected member")
	if len({parent.profile_id for parent in parents}) != 1:
		raise SidecarError("ROOM_IDENTITY_UNRESOLVED", "the parent carries conflicting profile identities")
	return parents[0]


def reconciled_room_reply(read: dict[str, Any], input_value: dict[str, Any], prepared: dict[str, Any]) -> str | None:
	if comment_id(read["comment"]["urn"]) != comment_id(input_value["parentCommentUrn"]):
		raise SidecarError("ROOM_TARGET_MOVED", "the receipt names a different parent comment")
	if prepared.get("ownReplyUrnsFrom") != "data":
		raise SidecarError("THREAD_INCOMPLETE", "room replies require the prepared data baseline", retryable=True)
	return reconciled_reply(read, prepared)
