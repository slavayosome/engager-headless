"""Wire constants, validation helpers, and protocol errors for NDJSON v1."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, NoReturn

PROTOCOL_VERSION = 1
SIDECAR_VERSION = "0.1.0"
CDP_USE_VERSION = "1.4.5"
SELECTOR_PACK_VERSION = "linkedin-2026-10-14.1"


@dataclass(slots=True)
class SidecarError(Exception):
	"""An expected failure that can safely cross the process boundary."""

	code: str
	message: str
	retryable: bool = False
	rate_limited: bool = False
	# Raised before anything was sent, or on LinkedIn's stated refusal of what
	# was, which created nothing: the write is not there. Set only where the
	# caller reads it as that (`like_attempt.pressed_nothing`).
	not_attempted: bool = False
	# What a caller needs to see a failure it must not act on — UI_DRIFT's page
	# fingerprint and redacted excerpt. Never page text.
	detail: dict[str, Any] | None = None

	def __str__(self) -> str:
		return self.message


def fail(code: str, message: str, *, retryable: bool = False, rate_limited: bool = False) -> NoReturn:
	raise SidecarError(code, message, retryable=retryable, rate_limited=rate_limited)


def require_object(value: Any, field: str) -> dict[str, Any]:
	if not isinstance(value, dict):
		fail("INVALID_REQUEST", f"{field} must be an object")
	return value


def require_string(value: Any, field: str, *, allow_empty: bool = False, max_length: int = 20_000) -> str:
	if not isinstance(value, str):
		fail("INVALID_REQUEST", f"{field} must be a string")
	if not allow_empty and not value.strip():
		fail("INVALID_REQUEST", f"{field} must not be empty")
	if len(value) > max_length:
		fail("INVALID_REQUEST", f"{field} is too long")
	return value


def optional_string(value: Any, field: str, *, max_length: int = 20_000) -> str | None:
	"""A string a request may leave out; given, it is held to `require_string`."""
	return None if value is None else require_string(value, field, max_length=max_length)


def optional_limit(value: Any, *, default: int, maximum: int) -> int:
	if value is None:
		return default
	if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > maximum:
		fail("INVALID_REQUEST", f"limit must be an integer between 1 and {maximum}")
	return value


def window_place(value: Any) -> dict[str, int]:
	"""The area of the screen a window is to be put in: left, top, width and
	height in screen points, and nothing else. A window smaller than a page can
	be read in, or beyond what any display holds, is refused rather than made."""
	place = require_object(value, "place")
	if set(place) != {"left", "top", "width", "height"}:
		fail("INVALID_REQUEST", "place takes left, top, width and height")
	for key, low, high in (("left", -16_000, 16_000), ("top", -16_000, 16_000), ("width", 400, 8_000), ("height", 400, 8_000)):
		number = place[key]
		if isinstance(number, bool) or not isinstance(number, int) or number < low or number > high:
			fail("INVALID_REQUEST", f"place.{key} must be an integer between {low} and {high}")
	return {key: place[key] for key in ("left", "top", "width", "height")}


def validate_post_input(value: Any) -> dict[str, Any]:
	input_value = require_object(value, "input")
	kind = require_string(input_value.get("kind"), "input.kind", max_length=20)
	if kind not in {"comment", "reply", "room_reply"}:
		fail("UNSUPPORTED_WRITE_KIND", "the Browser Use sidecar writes comments and replies only")

	post_urn = require_string(input_value.get("postUrn"), "input.postUrn", max_length=1_000)
	text = require_string(input_value.get("text"), "input.text", max_length=3_000)
	marker = require_string(input_value.get("marker"), "input.marker", max_length=1_000)
	if kind == "comment":
		return {"kind": "comment", "postUrn": post_urn, "text": text, "marker": marker}
	if kind == "room_reply":
		allowed = {"kind", "postUrn", "text", "marker", "parentCommentUrn", "expectedAuthorMemberUrn",
			"organizationId", "channelId", "expectedAccountProfileId"}
		if set(input_value) != allowed:
			fail("INVALID_REQUEST", "a room reply must carry exactly its bound target fields")
		channel_id = input_value.get("channelId")
		if isinstance(channel_id, bool) or not isinstance(channel_id, int) or channel_id < 1:
			fail("INVALID_REQUEST", "channelId must be a positive integer")
		member = require_string(input_value.get("expectedAuthorMemberUrn"), "expectedAuthorMemberUrn", max_length=220)
		organization = require_string(input_value.get("organizationId"), "organizationId", max_length=128)
		if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", organization):
			fail("INVALID_REQUEST", "organizationId must be a UUID")
		if not re.fullmatch(r"urn:li:fsd_profile:[A-Za-z0-9_-]{1,200}", member):
			fail("INVALID_REQUEST", "expectedAuthorMemberUrn must be a LinkedIn member urn")
		return {"kind": kind, "postUrn": post_urn, "text": text, "marker": marker,
			"parentCommentUrn": require_string(input_value.get("parentCommentUrn"), "parentCommentUrn", max_length=1_000),
			"expectedAuthorMemberUrn": member, "channelId": channel_id,
			"organizationId": organization,
			"expectedAccountProfileId": require_string(input_value.get("expectedAccountProfileId"), "expectedAccountProfileId", max_length=1_000)}
	# A reply sits under one of our comments and answers one reply beside it:
	# LinkedIn threads are two levels deep (reply_write.py).
	room_evidence = {}
	if "rootIsRoomReply" in input_value:
		root = require_object(input_value["rootIsRoomReply"], "rootIsRoomReply")
		if set(root) != {"replyUrn"}:
			fail("INVALID_REQUEST", "room root evidence must name exactly one confirmed reply")
		room_evidence = {"rootIsRoomReply": {"replyUrn": require_string(root.get("replyUrn"), "rootIsRoomReply.replyUrn", max_length=1_000)}}
	return {
		"kind": "reply",
		**room_evidence,
		"postUrn": post_urn,
		"parentCommentUrn": require_string(
			input_value.get("parentCommentUrn"), "input.parentCommentUrn", max_length=1_000
		),
		"replyToUrn": require_string(input_value.get("replyToUrn"), "input.replyToUrn", max_length=1_000),
		"text": text,
		"marker": marker,
	}


def input_fingerprint(input_value: dict[str, Any]) -> str:
	canonical = json.dumps(input_value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
	return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def ready_event() -> dict[str, Any]:
	return {
		"v": PROTOCOL_VERSION,
		"event": "ready",
		"protocol": "engager.browser-use",
		"protocolVersion": PROTOCOL_VERSION,
		"sidecarVersion": SIDECAR_VERSION,
		"cdpUseVersion": CDP_USE_VERSION,
		"selectorPackVersion": SELECTOR_PACK_VERSION,
	}


def success_response(request_id: str, op: str, result: dict[str, Any]) -> dict[str, Any]:
	return {"v": PROTOCOL_VERSION, "id": request_id, "op": op, "ok": True, "result": result}


def error_response(request_id: str, op: str, error: SidecarError) -> dict[str, Any]:
	payload: dict[str, Any] = {"code": error.code, "message": error.message}
	if error.retryable:
		payload["retryable"] = True
	if error.rate_limited:
		payload["rateLimited"] = True
	if error.not_attempted:
		payload["notAttempted"] = True
	if error.detail:
		payload["diagnostic"] = error.detail
	return {"v": PROTOCOL_VERSION, "id": request_id, "op": op, "ok": False, "error": payload}
