"""Versioned operation dispatcher and the write state machine: CLICKING before the POST."""

from __future__ import annotations

import re
import secrets
import time
from collections.abc import Awaitable
from typing import Any, Callable

from .agent_page import agent_read_target
from .backend import BrowserBackend
from .conversations import MEMBER_URN_RE
from .dm_open import Refused as OpenDmRefused
from .dm_open import conversation_of, opened_message, opened_receipt
from .dm_write import Refused as DmRefused
from .dm_write import ends_at, origin_token, receipt, sent_message
from .invitation_accept import INVITATION_URN_RE
from .invitation_accept import Refused as AcceptanceRefused
from .invitation_withdraw import Refused as WithdrawalRefused
from .invitation_withdraw import connected as member_connected
from .invitation_withdraw import still_pending, withdrawn
from .invitation_write import Refused, never_sent, sent
from .journal import DurableJournal
from .messaging import THREAD_ID_RE
from .replies import comment_id, profile_identity
from .protocol import (
	PROTOCOL_VERSION,
	SidecarError,
	error_response,
	fail,
	input_fingerprint,
	optional_limit,
	optional_string,
	require_object,
	require_string,
	success_response,
	validate_post_input,
	window_place,
)

SUPPORTED_OPS = {
	"warm_browser",
	"ensure_session",
	"discover_posts",
	"fetch_own_profile",
	"fetch_own_posts",
	"fetch_own_comments",
	"write",
	"reconcile_posted",
	"resolve_write_outcome",
	"settle_member_write",
	"like_post",
	"like_comment",
	"read_like_state",
	"read_post_thread",
	"read_author_profile",
	"read_company_page",
	"read_comment_replies",
	"read_notifications",
	"read_relationship",
	"read_incoming_invitations",
	"accept_invitation",
	"read_inbox",
	"read_dm_thread",
	"read_conversation_messages",
	"read_page_for_agent",
	"send_invitation",
	"withdraw_invitation",
	"send_dm",
	"open_dm",
	"set_window_visibility",
	"restart_browser",
	"close_browser",
	"shutdown",
}

# The most invitations one read returns.
MAX_INVITATIONS = 100
# The number in a member urn (`urn:li:member:<N>`), as a relationship read
# names it.
MEMBER_NUMBER_RE = re.compile(r"[0-9]{1,20}")

# The most messages one history read returns: two pages of LinkedIn's own.
MAX_HISTORY_MESSAGES = 40
# The most members a history read is told the profiles of: a group's worth.
MAX_KNOWN_MEMBERS = 100


def known_members(value: Any) -> dict[str, str]:
	"""A history read's `members` — each a member urn and the profile id a
	page read showed for it — as member urn to profile id; none where absent."""
	if value is None:
		return {}
	if not isinstance(value, list) or len(value) > MAX_KNOWN_MEMBERS:
		fail("INVALID_REQUEST", f"members must be a list of at most {MAX_KNOWN_MEMBERS}")
	known: dict[str, str] = {}
	for member in value:
		item = require_object(member, "a member")
		urn = item.get("memberUrn")
		if not isinstance(urn, str) or not MEMBER_URN_RE.fullmatch(urn):
			fail("INVALID_REQUEST", "a member's memberUrn must be a LinkedIn member urn")
		known[urn] = require_string(item.get("profileId"), "a member's profileId", max_length=1_000)
	return known

# The most replies a notification can vouch for in one thread read: a read's
# own bound on replies.
MAX_VOUCHED_REPLIES = 100

# The furthest offset a page of notification cards may start at: the third
# page of ten, the most one sweep reads.
MAX_NOTIFICATION_START = 20

# The longest DM LinkedIn's composer carries.
MAX_DM_CHARS = 8_000


# Failures of the page or the browser itself, a reply's target gone from it, and
# the account probe that could not answer. driver.ts PREPARE_REFUSAL_CODES
# answers them as "not posted" when a write raises them before its POST, so
# `write` must never raise one over an unresolved earlier click. `prepareRefusalCodes.test.ts`
# holds the two lists equal.
PAGE_FAILURE_CODES = frozenset(
	{
		"ACCOUNT_IDENTITY_UNAVAILABLE",
		"DOM_CHANGED",
		"NAVIGATION_FAILED",
		"NAVIGATION_BLOCKED",
		"BROWSER_TRANSIENT",
		"BROWSER_UNAVAILABLE",
		"PREPARED_UI_STALE",
		"UI_DRIFT",
		"THREAD_INCOMPLETE",
		"THREAD_UNAVAILABLE",
		"REPLY_TARGET_UNAVAILABLE",
		"ROOM_TARGET_MOVED",
		"ROOM_AUTHOR_CHANGED",
		"ROOM_ALREADY_OURS",
		"ROOM_IDENTITY_UNRESOLVED",
		"THREAD_MISMATCH",
		"COMMENTS_CLOSED",
	}
)
# LinkedIn's stated refusal of a write's one POST, by its kind: it created
# nothing, and the operation is never sent again (`BLOCKED`).
REFUSED_CODES = {"comment": "WRITE_REFUSED", "reply": "WRITE_REFUSED", "room_reply": "ROOM_REPLY_REFUSED"}
# What a read of a post's or a comment's thread raises when it stopped short of
# a comment LinkedIn counts, or only the page's markup answered: it found nothing,
# which proves no absence (`comment_data.py`).
UNPROVEN_ABSENCE_CODES = frozenset({"THREAD_INCOMPLETE", "THREAD_UNAVAILABLE"})
# How long after the press a whole read showing nothing of ours may say the
# comment or reply never went, or a read of Connect on offer that the invitation
# never did: LinkedIn's data can trail a write that landed. The quarter hour an
# invitation's or a DM's read waits in `actions/invite.ts` and `actions/dm.ts`.
ABSENCE_SETTLE_MS = 15 * 60_000


class SidecarService:
	def __init__(
		self,
		backend: BrowserBackend,
		journal: DurableJournal,
		*,
		clock_ms: Callable[[], int] | None = None,
	) -> None:
		self.backend = backend
		self.journal = journal
		self.clock_ms = clock_ms or (lambda: int(time.time() * 1000))
		self.stopped = False

	def _write_request(self, params: dict[str, Any]) -> tuple[str, dict[str, Any], str]:
		operation_id = require_string(params.get("operationId"), "operationId", max_length=1_000)
		input_value = validate_post_input(params.get("input"))
		if operation_id != input_value["marker"]:
			fail("OPERATION_MARKER_MISMATCH", "operationId must exactly equal input.marker")
		return operation_id, input_value, input_fingerprint(input_value)

	def _assert_entry_account(self, entry: dict[str, Any], account_id: str) -> None:
		journal_account = entry.get("accountId")
		if not isinstance(journal_account, str) or not journal_account:
			fail("ACCOUNT_BINDING_MISSING", "the write journal entry has no connected-account binding")
		if journal_account != account_id:
			fail("CONNECTED_ACCOUNT_CHANGED", "the local LinkedIn account changed for this write operation")

	def _matching_entry(self, operation_id: str, fingerprint: str, account_id: str) -> dict[str, Any] | None:
		entry = self.journal.get(operation_id)
		if entry is not None and entry.get("fingerprint") != fingerprint:
			fail("OPERATION_CONFLICT", f"operationId {operation_id} is already bound to different content")
		if entry is not None:
			self._assert_entry_account(entry, account_id)
		return entry

	async def _assert_account_before_press(self, account_id: str) -> None:
		"""The account the attempt was admitted on, probed once more immediately
		before the journal holds it as CLICKING -- the last thing done before
		the press. Whatever it raises, a probe that could not answer or another
		account signed in, comes before any press: nothing is journaled, and
		nothing went out."""
		self._assert_entry_account({"accountId": account_id}, await self.backend.connected_account_id(preserve_page=True))

	def _begin_click(self, operation_id: str, entry: dict[str, Any]) -> dict[str, Any]:
		"""The attempt journaled as CLICKING, durably, before anything is
		pressed or POSTed. It is the first write the journal makes for an
		attempt: a crash before it left no entry, so nothing was sent, and
		one after it is uncertain and never sent again."""
		now = self.clock_ms()
		return self.journal.put(
			operation_id,
			{**entry, "state": "CLICKING", "updatedAt": now, "clickStartedAt": now, "confirmationTokenHash": None, "expiresAt": None},
		)

	def _confirmed_entry(
		self,
		operation_id: str,
		input_value: dict[str, Any],
		fingerprint: str,
		account_id: str,
		external_urn: str,
		previous: dict[str, Any] | None,
	) -> dict[str, Any]:
		now = self.clock_ms()
		return self.journal.put(
			operation_id,
			{
				"operationId": operation_id,
				"state": "CONFIRMED",
				"input": input_value,
				"fingerprint": fingerprint,
				"accountId": account_id,
				"attempt": previous.get("attempt", 0) if previous else 0,
				"lastResolutionVersion": previous.get("lastResolutionVersion") if previous else None,
				"createdAt": previous.get("createdAt", now) if previous else now,
				"updatedAt": now,
				"externalUrn": external_urn,
				"confirmationTokenHash": None,
				"expiresAt": None,
				"error": None,
				"retryable": False,
				"rateLimited": False,
			},
		)

	async def _write(self, params: dict[str, Any]) -> dict[str, Any]:
		"""Send a comment, a reply or a room reply, once, in one request: an
		earlier attempt under the id is adopted or refused first; the post's page
		is opened and what the POST will send is fixed from it; the account is
		probed; the journal holds the attempt as CLICKING, durably; and only
		then is the POST made. Nothing is journaled before that, so a refusal
		short of it sent nothing; from CLICKING on, whatever goes wrong is
		uncertain and nothing under the id is sent again."""
		operation_id, input_value, fingerprint = self._write_request(params)
		prior = self.journal.get(operation_id)
		try:
			account_id = await self.backend.connected_account_id()
			self._room_account(input_value, account_id)
			entry = self._matching_entry(operation_id, fingerprint, account_id)
			if entry and entry["state"] == "BLOCKED":
				fail(
					REFUSED_CODES[input_value["kind"]],
					f"LinkedIn refused this {input_value['kind']}; this operation is never sent again",
				)
			if entry and entry["state"] == "CONFIRMED":
				return {
					"operationId": operation_id,
					"state": "already_committed",
					"externalUrn": entry.get("externalUrn"),
				}

			# A new version still owes the previous attempt a read. A late receipt
			# is adopted before preparing anything that could be pressed again.
			versioned = re.fullmatch(r"(.+):v([1-9][0-9]*)", operation_id)
			if versioned:
				for old_id, old in self.journal.previous_attempts(versioned.group(1), int(versioned.group(2))):
					if old["state"] not in {"CLICKING", "UNCERTAIN"} and old.get("accountId") != account_id:
						continue
					self._assert_entry_account(old, account_id)
					if old["state"] in {"CLICKING", "UNCERTAIN"}:
						fail("WRITE_OUTCOME_UNCERTAIN", "an earlier attempt still needs resolution")
					if old["state"] not in {"RESOLVED_NOT_POSTED", "CONFIRMED"}:
						continue
					old_input = old.get("input")
					if not isinstance(old_input, dict):
						fail("JOURNAL_CORRUPT", "an earlier attempt has no input")
					old_urn = old.get("externalUrn") if old["state"] == "CONFIRMED" else await self._reconcile(old_input, old)
					if old["state"] == "CONFIRMED" and not old_urn:
						fail("WRITE_OUTCOME_UNCERTAIN", "an earlier confirmed attempt has no receipt")
					if not old_urn:
						continue
					if old["state"] == "RESOLVED_NOT_POSTED":
						# The owner said it did not post and LinkedIn now shows it:
						# neither is adopted over the other.
						fail("WRITE_OUTCOME_UNCERTAIN", "an earlier attempt the owner marked not posted now shows on LinkedIn")
					self._confirmed_entry(old_id, old_input, old["fingerprint"], account_id, old_urn, old)
					if {k: v for k, v in old_input.items() if k != "marker"} != {k: v for k, v in input_value.items() if k != "marker"}:
						fail("WRITE_OUTCOME_UNCERTAIN", "an earlier attempt landed with different words")
					self._confirmed_entry(operation_id, input_value, fingerprint, account_id, old_urn, entry)
					return {"operationId": operation_id, "state": "already_committed", "externalUrn": old_urn}

			# A prior process may have died around the click.  A read-only reconcile
			# may adopt it; a miss must never lead to another click.
			try:
				external_urn = await self._reconcile(input_value, entry)
			except SidecarError as exc:
				# A read that stopped short found nothing, which proves no absence.
				if exc.code not in UNPROVEN_ABSENCE_CODES:
					raise
				external_urn = None
		except SidecarError as exc:
			# The client reads a page or browser failure from a write as "never
			# reached the click" (PREPARE_REFUSAL_CODES in driver.ts). That is only
			# true of THIS attempt: with an earlier click still unresolved in the
			# journal, the honest answer stays uncertain whatever stopped the probe.
			if prior and prior.get("state") in {"CLICKING", "UNCERTAIN"} and exc.code in PAGE_FAILURE_CODES:
				raise SidecarError(
					"WRITE_OUTCOME_UNCERTAIN",
					"a prior click may have reached LinkedIn; reconcile or resolve it manually",
				) from exc
			raise
		if external_urn:
			self._confirmed_entry(operation_id, input_value, fingerprint, account_id, external_urn, entry)
			return {"operationId": operation_id, "state": "already_committed", "externalUrn": external_urn}
		if entry and entry["state"] in {"CLICKING", "UNCERTAIN"}:
			fail(
				"WRITE_OUTCOME_UNCERTAIN",
				"a prior click may have reached LinkedIn; reconcile or resolve it manually",
			)

		# Short of the POST nothing writes: the post's page is opened once (the
		# visit the reconcile read above may already have made), and what the
		# POST will send -- the thread, and for a reply its evidence of what was
		# already there -- is fixed from it and journaled with the attempt.
		reply_prepared: dict[str, Any] | None = None
		comment_prepared: dict[str, Any] | None = None
		if input_value["kind"] == "room_reply":
			reply_prepared = await self.backend.prepare_room_reply(input_value)
			await self.backend.validate_prepared_room_reply(input_value, reply_prepared)
		elif input_value["kind"] == "reply":
			reply_prepared = await self.backend.prepare_reply(input_value)
			await self.backend.validate_prepared_reply(input_value, reply_prepared)
		else:
			comment_prepared = await self.backend.prepare_comment(input_value)
			await self.backend.validate_prepared_comment(input_value, comment_prepared)

		# The last look at who is signed in comes BEFORE the attempt is held as
		# CLICKING: a probe that cannot answer has pressed nothing, so it refuses
		# the write with no entry rather than leaving an uncertain one that
		# holds the account.
		await self._assert_account_before_press(account_id)

		now = self.clock_ms()
		prior_attempt = int(entry.get("attempt") or 0) if entry else 0
		attempt = prior_attempt + 1 if entry and entry["state"] == "RESOLVED_NOT_POSTED" else max(1, prior_attempt)
		clicking = self._begin_click(
			operation_id,
			{
				"operationId": operation_id,
				"input": input_value,
				"fingerprint": fingerprint,
				"accountId": account_id,
				"attempt": attempt,
				"lastResolutionVersion": entry.get("lastResolutionVersion") if entry else None,
				"createdAt": entry.get("createdAt", now) if entry else now,
				"externalUrn": None,
				"error": None,
				"retryable": False,
				"rateLimited": False,
				**({"replyPrepared": reply_prepared} if reply_prepared is not None else {}),
				**({"commentPrepared": comment_prepared} if comment_prepared is not None else {}),
			},
		)
		try:
			if clicking["input"]["kind"] == "room_reply":
				external_urn = await self.backend.commit_prepared_room_reply(
					clicking["input"], str(clicking["accountId"]), clicking["replyPrepared"]
				)
			elif clicking["input"]["kind"] == "reply":
				external_urn = await self.backend.commit_prepared_reply(
					clicking["input"], str(clicking["accountId"]), clicking["replyPrepared"]
				)
			else:
				external_urn = await self.backend.commit_prepared_comment(clicking["input"], clicking["commentPrepared"])
		except SidecarError as exc:
			error = exc
		except Exception as exc:  # outcome must remain uncertain across unexpected process/provider failures
			error = SidecarError("WRITE_FAILED_AFTER_CLICK_START", str(exc))
		else:
			error = None

		if error is None and external_urn:
			self._confirmed_entry(
				operation_id,
				clicking["input"],
				str(clicking["fingerprint"]),
				account_id,
				external_urn,
				clicking,
			)
			return {"operationId": operation_id, "state": "committed", "externalUrn": external_urn}

		if error is not None and error.code == REFUSED_CODES[clicking["input"]["kind"]]:
			self.journal.mutate(operation_id, lambda current: {
				**current, "state": "BLOCKED", "updatedAt": self.clock_ms(), "error": error.message,
				"retryable": False, "rateLimited": False,
			})
			return {"operationId": operation_id, "state": "failed", "code": error.code, "error": error.message}

		message = (
			error.message
			if error is not None
			else f"the {clicking['input']['kind']} was sent, but LinkedIn named no {clicking['input']['kind']} for it"
		)

		def mark_uncertain(current: dict[str, Any]) -> dict[str, Any]:
			current.update(
				{
					"state": "UNCERTAIN",
					"updatedAt": self.clock_ms(),
					"error": message,
					"retryable": bool(error and error.retryable),
					"rateLimited": bool(error and error.rate_limited),
				}
			)
			return current

		uncertain = self.journal.mutate(operation_id, mark_uncertain)
		return self._uncertain_result(operation_id, uncertain)

	async def _reconcile(self, input_value: dict[str, Any], entry: dict[str, Any] | None) -> str | None:
		"""Whether an earlier attempt of this operation landed.

		A reply is told from an identical earlier reply of ours only by the
		evidence its attempt journalled at prepare, so a reply with no prepared
		attempt has nothing of its own to adopt: no click of this journal's can
		have landed, and a matching reply already there is not this one. A
		comment sent under this journal is told from an identical earlier one
		of ours by when it was written: since the attempt's send."""
		if input_value["kind"] not in {"reply", "room_reply"}:
			sent_at = entry.get("clickStartedAt") if entry else None
			return await self.backend.reconcile_posted(input_value, sent_at if isinstance(sent_at, int) else None)
		prepared = entry.get("replyPrepared") if entry else None
		if not isinstance(prepared, dict):
			return None
		if input_value["kind"] == "room_reply":
			return await self.backend.reconcile_room_reply(input_value, prepared)
		return await self.backend.reconcile_reply(input_value, prepared)

	@staticmethod
	def _room_account(input_value: dict[str, Any], account_id: str) -> None:
		if input_value["kind"] != "room_reply":
			return
		identity = profile_identity(account_id)
		if identity is None or identity[0] != input_value["expectedAccountProfileId"]:
			fail("ACCOUNT_CHANGED", "the connected account is not the room reply's selected account")

	def _uncertain_result(self, operation_id: str, entry: dict[str, Any]) -> dict[str, Any]:
		result: dict[str, Any] = {
			"operationId": operation_id,
			"state": "uncertain",
			"error": entry.get("error") or "write outcome is uncertain; reconcile before any further action",
		}
		if entry.get("retryable"):
			result["retryable"] = True
		if entry.get("rateLimited"):
			result["rateLimited"] = True
		return result

	async def _reconcile_posted(self, params: dict[str, Any]) -> dict[str, Any]:
		operation_id, input_value, fingerprint = self._write_request(params)
		account_id = await self.backend.connected_account_id()
		self._room_account(input_value, account_id)
		entry = self._matching_entry(operation_id, fingerprint, account_id)
		if entry and entry["state"] == "CONFIRMED":
			return {"operationId": operation_id, "externalUrn": entry.get("externalUrn")}

		external_urn = await self._reconcile(input_value, entry)
		if external_urn:
			self._confirmed_entry(operation_id, input_value, fingerprint, account_id, external_urn, entry)
		elif entry and entry["state"] == "CLICKING":
			def interrupted(current: dict[str, Any]) -> dict[str, Any]:
				current.update(
					{
						"state": "UNCERTAIN",
						"updatedAt": self.clock_ms(),
						"error": "clicking was interrupted and no authored match was found",
					}
				)
				return current

			self.journal.mutate(operation_id, interrupted)
		return {"operationId": operation_id, "externalUrn": external_urn}

	async def _resolve_write_outcome(self, params: dict[str, Any]) -> dict[str, Any]:
		operation_id, input_value, fingerprint = self._write_request(params)
		outcome = params.get("outcome")
		if outcome not in {"confirmed_not_posted", "confirmed_posted"}:
			fail("INVALID_REQUEST", "invalid write outcome")
		resolution_version = params.get("resolutionVersion")
		if isinstance(resolution_version, bool) or not isinstance(resolution_version, int) or resolution_version < 0:
			fail("INVALID_REQUEST", "resolutionVersion must be a non-negative integer")

		account_id = await self.backend.connected_account_id()
		self._room_account(input_value, account_id)
		entry = self._matching_entry(operation_id, fingerprint, account_id)
		if outcome == "confirmed_posted":
			urn = require_string(params.get("externalUrn"), "externalUrn", max_length=1000)
			if entry and entry["state"] == "CONFIRMED" and entry.get("externalUrn") != urn:
				fail("OPERATION_CONFLICT", "the confirmed receipt differs")
			if entry and entry["state"] not in {"CLICKING", "UNCERTAIN", "CONFIRMED", "RESOLVED_NOT_POSTED"}:
				fail("WRITE_NOT_UNCERTAIN", "the write was already resolved")
			self._confirmed_entry(operation_id, input_value, fingerprint, account_id, urn, entry)
			return {"operationId": operation_id, "state": "already_committed", "resolutionVersion": resolution_version, "externalUrn": urn}
		if entry and entry["state"] == "CONFIRMED":
			return {
				"operationId": operation_id,
				"state": "already_committed",
				"resolutionVersion": resolution_version,
				"externalUrn": entry.get("externalUrn"),
			}

		last_resolution = entry.get("lastResolutionVersion") if entry else None
		last_resolution_version = int(last_resolution) if isinstance(last_resolution, int) else -1
		if resolution_version <= last_resolution_version:
			if entry and entry["state"] == "RESOLVED_NOT_POSTED" and resolution_version == last_resolution_version:
				return {
					"operationId": operation_id,
					"state": "resolved_not_posted",
					"resolutionVersion": resolution_version,
				}
			fail("STALE_RESOLUTION", "this resolution version cannot clear the current write attempt")
		if entry and entry["state"] not in {"CLICKING", "UNCERTAIN"}:
			fail("WRITE_NOT_UNCERTAIN", "the current write state cannot be resolved as not posted")

		# The owner looked on LinkedIn and said it did not post: that is recorded
		# as said. No read and no waiting stand in for it; a later sighting that
		# contradicts it is held for the owner, never adopted (see `_write`).
		if entry is None:
			now = self.clock_ms()
			self.journal.put(
				operation_id,
				{
					"operationId": operation_id,
					"state": "RESOLVED_NOT_POSTED",
					"input": input_value,
					"fingerprint": fingerprint,
					"accountId": account_id,
					"attempt": 0,
					"lastResolutionVersion": resolution_version,
					"createdAt": now,
					"updatedAt": now,
					"resolvedAt": now,
					"confirmationTokenHash": None,
					"expiresAt": None,
					"externalUrn": None,
					"error": None,
					"retryable": False,
					"rateLimited": False,
				},
			)
			return {
				"operationId": operation_id,
				"state": "resolved_not_posted",
				"resolutionVersion": resolution_version,
			}

		def resolve_not_posted(current: dict[str, Any]) -> dict[str, Any]:
			self._assert_entry_account(current, account_id)
			if current.get("fingerprint") != fingerprint:
				raise SidecarError("OPERATION_CONFLICT", "write content changed before resolution")
			if current.get("state") not in {"CLICKING", "UNCERTAIN"}:
				raise SidecarError("WRITE_NOT_UNCERTAIN", "write state changed before resolution")
			current_last = current.get("lastResolutionVersion")
			if isinstance(current_last, int) and resolution_version <= current_last:
				raise SidecarError("STALE_RESOLUTION", "resolution version is not newer")
			current.update(
				{
					"state": "RESOLVED_NOT_POSTED",
					"updatedAt": self.clock_ms(),
					"resolvedAt": self.clock_ms(),
					"lastResolutionVersion": resolution_version,
					"confirmationTokenHash": None,
					"expiresAt": None,
					"error": None,
					"retryable": False,
					"rateLimited": False,
				}
			)
			return current

		self.journal.mutate(operation_id, resolve_not_posted)
		return {
			"operationId": operation_id,
			"state": "resolved_not_posted",
			"resolutionVersion": resolution_version,
		}

	async def _settle_member_write(self, params: dict[str, Any]) -> dict[str, Any]:
		"""The owner's word on an invitation, acceptance, withdrawal or DM nobody
		saw land, recorded in its journal entry as said: `went_out` closes it
		CONFIRMED and `not_sent` RESOLVED_NOT_POSTED. It reads and presses
		nothing, and no waiting stands in for it. An id the journal never held
		sent nothing, and has nothing to close. An entry the sidecar itself
		settled the other way is `contradicted`: neither answer replaces the
		other, and the caller holds it for the owner."""
		operation_id = require_string(params.get("operationId"), "operationId", max_length=1_000)
		outcome = params.get("outcome")
		if outcome not in {"went_out", "not_sent"}:
			fail("INVALID_REQUEST", "outcome must be went_out or not_sent")
		entry = self.journal.get(operation_id)
		if entry is None:
			return {"operationId": operation_id, "state": "not_journaled"}
		self._assert_entry_account(entry, await self.backend.connected_account_id())
		state = entry["state"]
		target = "CONFIRMED" if outcome == "went_out" else "RESOLVED_NOT_POSTED"
		if state == target or (state == "BLOCKED" and outcome == "not_sent"):
			return {"operationId": operation_id, "state": "recorded"}
		if state not in {"CLICKING", "UNCERTAIN"}:
			return {"operationId": operation_id, "state": "contradicted"}

		def close(current: dict[str, Any]) -> dict[str, Any]:
			current.update(
				{
					"state": target,
					"updatedAt": self.clock_ms(),
					"resolvedAt": self.clock_ms(),
					"ownerResolved": outcome,
					"confirmationTokenHash": None,
					"expiresAt": None,
					"error": None,
					"retryable": False,
					"rateLimited": False,
				}
			)
			return current

		self.journal.mutate(operation_id, close)
		return {"operationId": operation_id, "state": "recorded"}

	def _acceptance_request(self, params: dict[str, Any]) -> tuple[str, dict[str, Any], str]:
		"""The operation id and the request an acceptance's every step names:
		the invitation and its sender, bound by the fingerprint the caller
		computed over them — recomputed here."""
		operation_id = require_string(params.get("operationId"), "operationId", max_length=1_000)
		invitation_id = require_string(params.get("invitationId"), "invitationId", max_length=1_000)
		if not INVITATION_URN_RE.fullmatch(invitation_id):
			fail("INVALID_REQUEST", "invitationId must be a LinkedIn invitation urn")
		input_value = {
			"kind": "accept_invitation",
			"invitationId": invitation_id,
			"senderProfileId": require_string(params.get("senderProfileId"), "senderProfileId", max_length=1_000),
		}
		fingerprint = input_fingerprint(input_value)
		if params.get("fingerprint") != fingerprint:
			fail("FINGERPRINT_MISMATCH", "the acceptance's fingerprint is not its invitation and sender")
		return operation_id, input_value, fingerprint

	@staticmethod
	def _acceptance(operation_id: str, fingerprint: str, state: str, **rest: Any) -> dict[str, Any]:
		return {"operationId": operation_id, "fingerprint": fingerprint, "state": state, **rest}

	def _settled_acceptance(self, operation_id: str, fingerprint: str, entry: dict[str, Any]) -> dict[str, Any] | None:
		"""What an entry past its press already answers, or None for one a new
		attempt may start from (`RESOLVED_NOT_POSTED`)."""
		state = entry["state"]
		if state == "CONFIRMED":
			return self._acceptance(operation_id, fingerprint, "confirmed", relationship=entry.get("relationship"))
		if state == "BLOCKED":
			return self._acceptance(
				operation_id,
				fingerprint,
				"blocked",
				reason="invitation_withdrawn",
				detail=str(entry.get("error"))[:500],
				relationship=entry.get("relationship"),
			)
		if state in {"CLICKING", "UNCERTAIN"}:
			return self._acceptance(
				operation_id,
				fingerprint,
				"uncertain",
				error=str(entry.get("error") or "a prior Accept may have reached LinkedIn; resolve it before anything else")[:500],
				relationship=entry.get("relationship"),
			)
		return None

	async def _press_acceptance(self, params: dict[str, Any]) -> dict[str, Any]:
		"""Accept, once, in one request. The invitations page's data is
		re-read and the one Accept bound, the bound Accept re-validated and the
		account probed -- all of it pressing nothing -- before the journal holds
		the attempt as CLICKING, durably; so any of them failing pressed
		nothing and journaled nothing. An earlier attempt under the same id
		that reached its press answers for itself and is never pressed again.
		From CLICKING on, whatever goes wrong is uncertain and nothing under the
		id is pressed again. Only a page script that refused before its press
		settles as not pressed, and only the sender reading connected settles it
		as accepted: a profile offering Connect right after the press may simply
		not have caught up, so what looks like a withdrawal here stays
		uncertain, for a later read to call (`_resolve_acceptance`)."""
		operation_id, input_value, fingerprint = self._acceptance_request(params)
		account_id = await self.backend.connected_account_id()
		entry = self._matching_entry(operation_id, fingerprint, account_id)
		settled = self._settled_acceptance(operation_id, fingerprint, entry) if entry else None
		if settled is not None:
			return settled
		tag = secrets.token_hex(8)
		try:
			prepared = await self.backend.prepare_acceptance(input_value, tag)
		except AcceptanceRefused as refused:
			return self._acceptance(
				operation_id,
				fingerprint,
				"refused",
				reason=refused.reason,
				**({"detail": refused.detail[:500]} if refused.detail else {}),
			)
		await self.backend.validate_prepared_acceptance(input_value, prepared)
		await self._assert_account_before_press(account_id)
		now = self.clock_ms()
		clicking = self._begin_click(
			operation_id,
			{
				"operationId": operation_id,
				"input": input_value,
				"fingerprint": fingerprint,
				"accountId": account_id,
				"attempt": int(entry.get("attempt") or 0) + 1 if entry else 1,
				"createdAt": entry.get("createdAt", now) if entry else now,
				"acceptancePrepared": prepared,
				"relationship": None,
				"error": None,
			},
		)
		outcome: dict[str, Any] | None = None
		try:
			outcome = await self.backend.commit_prepared_acceptance(clicking["input"], clicking["acceptancePrepared"])
		except SidecarError as exc:
			error: SidecarError | None = exc
		except Exception as exc:  # the press may have reached LinkedIn
			error = SidecarError("WRITE_FAILED_AFTER_CLICK_START", str(exc))
		else:
			error = None

		state = (outcome or {}).get("state")
		relationship = (outcome or {}).get("relationship")
		if state == "confirmed":
			self._settle_invitation(operation_id, "CONFIRMED", relationship=relationship, error=None)
			return self._acceptance(operation_id, fingerprint, "confirmed", relationship=relationship)
		if state == "not_pressed":
			self._settle_invitation(operation_id, "RESOLVED_NOT_POSTED", error=str((outcome or {}).get("error"))[:500])
			return self._acceptance(operation_id, fingerprint, "resolved_not_sent", relationship=None)
		if error is not None:
			message = error.message[:500]
		elif state == "still_pending":
			message = "the invitation still shows pending after Accept"
		elif state == "withdrawn":
			message = "the sender's profile offers Connect right after Accept; only a later read may call that a withdrawal"
		else:
			message = str((outcome or {}).get("error") or "the Accept's outcome is unknown")[:500]
		self._settle_invitation(
			operation_id,
			"UNCERTAIN",
			error=message,
			relationship=relationship,
			retryable=bool(error and error.retryable),
			rateLimited=bool(error and error.rate_limited),
		)
		return self._acceptance(operation_id, fingerprint, "uncertain", error=message, relationship=relationship)

	async def _resolve_acceptance(self, params: dict[str, Any]) -> dict[str, Any]:
		"""What became of an attempt nobody saw land, from the sender's profile
		and the invitations page's data read in this session — never a press. An
		id that never reached its press accepted nothing, and is closed so no
		later commit under it can press. A request still listed leaves the
		attempt open: whether that is long enough after the press to say
		nothing was accepted is the caller's to judge (`still_pending`).

		The caller budgets every page it loads, so `reads` says how many this
		resolve may (0, 1 or 2: the profile, then the data). What the journal
		alone answers costs none; where a page is needed and none is granted,
		`read_needed` says so and touches nothing."""
		operation_id, input_value, fingerprint = self._acceptance_request(params)
		reads = params.get("reads")
		if isinstance(reads, bool) or reads not in (0, 1, 2):
			fail("INVALID_REQUEST", "reads must be 0, 1 or 2")
		account_id = await self.backend.connected_account_id()
		entry = self._matching_entry(operation_id, fingerprint, account_id)
		if entry is not None and entry["state"] in {"CONFIRMED", "BLOCKED"}:
			return self._settled_acceptance(operation_id, fingerprint, entry)  # type: ignore[return-value]
		if entry is None or entry["state"] == "RESOLVED_NOT_POSTED":
			return self._acceptance(operation_id, fingerprint, "resolved_not_sent", relationship=None)
		if reads == 0:
			return self._acceptance(operation_id, fingerprint, "read_needed")
		outcome = await self.backend.acceptance_read_back(input_value, pages=reads)
		relationship = outcome.get("relationship")
		if outcome["state"] == "confirmed":
			self._settle_invitation(operation_id, "CONFIRMED", relationship=relationship, error=None)
			return self._acceptance(operation_id, fingerprint, "confirmed", relationship=relationship)
		if outcome["state"] == "withdrawn":
			detail = "the sender's invitation is gone and their profile offers Connect: they withdrew it"
			self._settle_invitation(operation_id, "BLOCKED", error=detail, relationship=relationship)
			return self._acceptance(
				operation_id, fingerprint, "blocked", reason="invitation_withdrawn", detail=detail, relationship=relationship
			)
		self._settle_invitation(operation_id, "UNCERTAIN", relationship=relationship)
		if outcome["state"] == "still_pending":
			return self._acceptance(
				operation_id, fingerprint, "still_pending", relationship=relationship, observedAt=outcome["observedAt"]
			)
		return self._acceptance(
			operation_id,
			fingerprint,
			"uncertain",
			error=str(outcome.get("error") or "the read could not tell what the Accept did")[:500],
			relationship=relationship,
		)

	async def _accept_invitation(self, params: dict[str, Any]) -> dict[str, Any]:
		step = params.get("step")
		if step == "send":
			return await self._press_acceptance(params)
		if step == "resolve":
			return await self._resolve_acceptance(params)
		fail("INVALID_REQUEST", "step must be send or resolve")

	def _invitation_request(self, params: dict[str, Any]) -> tuple[str, dict[str, Any], str]:
		"""The operation id and the content an invitation's every step names:
		the member and the note, bound by the fingerprint the caller computed
		over them — recomputed here, so the bytes typed are the bytes approved."""
		operation_id = require_string(params.get("operationId"), "operationId", max_length=1_000)
		input_value = {
			"kind": "invitation",
			"profileId": require_string(params.get("profileId"), "profileId", max_length=1_000),
			"note": require_string(params.get("note"), "note", max_length=3_000),
		}
		fingerprint = input_fingerprint(input_value)
		if params.get("fingerprint") != fingerprint:
			fail("FINGERPRINT_MISMATCH", "the invitation's fingerprint is not its member and note")
		return operation_id, input_value, fingerprint

	@staticmethod
	def _invitation(operation_id: str, fingerprint: str, state: str, **rest: Any) -> dict[str, Any]:
		return {"operationId": operation_id, "fingerprint": fingerprint, "state": state, **rest}

	def _settled_invitation(self, operation_id: str, fingerprint: str, entry: dict[str, Any]) -> dict[str, Any] | None:
		"""What an entry past its press already answers, or None for one a new
		attempt may start from (`RESOLVED_NOT_POSTED`)."""
		state = entry["state"]
		if state == "CONFIRMED":
			prepared = entry.get("invitationPrepared") or {}
			return self._invitation(
				operation_id,
				fingerprint,
				"confirmed",
				relationship=entry.get("relationship"),
				noteLimit=prepared.get("noteLimit"),
				**({"receipt": entry["receipt"]} if entry.get("receipt") else {}),
			)
		if state == "BLOCKED":
			return self._invitation(
				operation_id, fingerprint, "blocked", reason="refused_after_send", detail=str(entry.get("error"))[:500]
			)
		if state in {"CLICKING", "UNCERTAIN"}:
			return self._invitation(
				operation_id,
				fingerprint,
				"uncertain",
				error=str(entry.get("error") or "a prior Send may have reached LinkedIn; resolve it before anything else")[:500],
				relationship=entry.get("relationship"),
			)
		return None

	def _settle_invitation(self, operation_id: str, state: str, **fields: Any) -> dict[str, Any]:
		def settle(current: dict[str, Any]) -> dict[str, Any]:
			current.update(
				{
					"state": state,
					"updatedAt": self.clock_ms(),
					"confirmationTokenHash": None,
					"expiresAt": None,
					**fields,
				}
			)
			return current

		return self.journal.mutate(operation_id, settle)

	async def _press_invitation(self, params: dict[str, Any]) -> dict[str, Any]:
		"""Send, once, in one request: the member is re-read against `expected`
		and the compose view's note limit stated, the page re-validated and the
		account probed -- pressing nothing -- before the journal holds the
		attempt as CLICKING, durably; so a refusal sent nothing and journaled
		nothing. An earlier attempt under the same id that reached its POST
		answers for itself and is never sent again. From CLICKING on, whatever
		goes wrong is uncertain and nothing under the id is sent again."""
		operation_id, input_value, fingerprint = self._invitation_request(params)
		expected = require_object(params.get("expected"), "expected")
		if expected.get("degree") not in {"2nd", "3rd+"} or expected.get("pending") != "none":
			fail("INVALID_REQUEST", "an invitation is admitted only for a 2nd or 3rd+ member with nothing pending")
		member_urn, member_id = expected.get("profileUrn"), expected.get("memberId")
		if not isinstance(member_urn, str) or not MEMBER_URN_RE.fullmatch(member_urn):
			fail("INVALID_REQUEST", "expected.profileUrn must be the member's profile urn the admitting read bound")
		if not isinstance(member_id, str) or not MEMBER_NUMBER_RE.fullmatch(member_id):
			fail("INVALID_REQUEST", "expected.memberId must be the member number the admitting read bound")
		account_id = await self.backend.connected_account_id()
		entry = self._matching_entry(operation_id, fingerprint, account_id)
		settled = self._settled_invitation(operation_id, fingerprint, entry) if entry else None
		if settled is not None:
			return settled
		try:
			prepared = await self.backend.prepare_invitation(input_value, expected)
		except Refused as refused:
			return self._invitation(
				operation_id,
				fingerprint,
				"refused",
				reason=refused.reason,
				**({"detail": refused.detail[:500]} if refused.detail else {}),
				**({"noteLimit": refused.limit} if refused.limit is not None else {}),
			)
		await self.backend.validate_prepared_invitation(input_value, prepared)
		await self._assert_account_before_press(account_id)
		now = self.clock_ms()
		clicking = self._begin_click(
			operation_id,
			{
				"operationId": operation_id,
				"input": input_value,
				"fingerprint": fingerprint,
				"accountId": account_id,
				"attempt": int(entry.get("attempt") or 0) + 1 if entry else 1,
				"createdAt": entry.get("createdAt", now) if entry else now,
				"invitationPrepared": prepared,
				"relationship": None,
				"error": None,
			},
		)
		outcome: dict[str, Any] | None = None
		try:
			outcome = await self.backend.commit_prepared_invitation(clicking["input"], clicking["invitationPrepared"])
		except SidecarError as exc:
			error: SidecarError | None = exc
		except Exception as exc:  # the press may have reached LinkedIn
			error = SidecarError("WRITE_FAILED_AFTER_CLICK_START", str(exc))
		else:
			error = None

		if outcome is not None and outcome.get("state") == "confirmed":
			self._settle_invitation(
				operation_id, "CONFIRMED", relationship=outcome["relationship"], receipt=outcome["receipt"], error=None
			)
			return self._invitation(
				operation_id,
				fingerprint,
				"confirmed",
				relationship=outcome["relationship"],
				noteLimit=clicking["invitationPrepared"].get("noteLimit"),
				receipt=outcome["receipt"],
			)
		if outcome is not None and outcome.get("state") == "blocked":
			detail = str(outcome.get("detail") or "LinkedIn refused the invitation")[:500]
			self._settle_invitation(operation_id, "BLOCKED", error=detail)
			return self._invitation(operation_id, fingerprint, "blocked", reason="refused_after_send", detail=detail)
		message = (error.message if error is not None else str((outcome or {}).get("error") or "Send's outcome is unknown"))[:500]
		relationship = (outcome or {}).get("relationship")
		self._settle_invitation(
			operation_id,
			"UNCERTAIN",
			error=message,
			relationship=relationship,
			retryable=bool(error and error.retryable),
			rateLimited=bool((error and error.rate_limited) or (outcome or {}).get("rateLimited")),
		)
		return self._invitation(operation_id, fingerprint, "uncertain", error=message, relationship=relationship)

	async def _resolve_invitation(self, params: dict[str, Any]) -> dict[str, Any]:
		"""What became of an attempt nobody saw land, from a read of the member's
		profile in this session — never a press. An id that never reached Send
		sent nothing, and is closed so no later commit under it can press; one
		that did is closed as not sent only by a read of Connect on offer made a
		quarter hour after the press."""
		operation_id, input_value, fingerprint = self._invitation_request(params)
		account_id = await self.backend.connected_account_id()
		entry = self._matching_entry(operation_id, fingerprint, account_id)
		if entry is not None and entry["state"] in {"CONFIRMED", "BLOCKED"}:
			return self._settled_invitation(operation_id, fingerprint, entry)  # type: ignore[return-value]
		if entry is None or entry["state"] == "RESOLVED_NOT_POSTED":
			return self._invitation(operation_id, fingerprint, "resolved_not_sent", relationship=None)
		relationship = await self.backend.read_relationship(input_value["profileId"], None)
		member = input_value["profileId"].lower()
		admitted = (entry.get("invitationPrepared") or {}).get("relationship") or {}
		if sent(relationship, member, admitted, withdrawn=True):
			self._settle_invitation(operation_id, "CONFIRMED", relationship=relationship, error=None)
			return self._invitation(
				operation_id,
				fingerprint,
				"confirmed",
				relationship=relationship,
				noteLimit=(entry.get("invitationPrepared") or {}).get("noteLimit"),
			)
		if never_sent(relationship, member, admitted):
			# Connect on offer is LinkedIn's data stating no invitation, but that
			# data can trail a Send that landed: the attempt closes as not sent
			# only on a read made a quarter hour after the press, never on an
			# earlier one that a later look would then inherit unread.
			pressed_at = entry.get("clickStartedAt")
			if isinstance(pressed_at, int) and self.clock_ms() - pressed_at >= ABSENCE_SETTLE_MS:
				self._settle_invitation(
					operation_id, "RESOLVED_NOT_POSTED", relationship=relationship, resolvedAt=self.clock_ms()
				)
				return self._invitation(operation_id, fingerprint, "resolved_not_sent", relationship=relationship)
			self._settle_invitation(operation_id, "UNCERTAIN", relationship=relationship)
			return self._invitation(
				operation_id,
				fingerprint,
				"uncertain",
				error="their Connect is on offer, but the press is too recent for LinkedIn's data to show an invitation that landed",
				relationship=relationship,
			)
		self._settle_invitation(operation_id, "UNCERTAIN", relationship=relationship)
		return self._invitation(
			operation_id,
			fingerprint,
			"uncertain",
			error="the profile's data shows the admitted member neither invited nor on Connect",
			relationship=relationship,
		)

	async def _send_invitation(self, params: dict[str, Any]) -> dict[str, Any]:
		step = params.get("step")
		if step == "send":
			return await self._press_invitation(params)
		if step == "resolve":
			return await self._resolve_invitation(params)
		fail("INVALID_REQUEST", "step must be send or resolve")

	def _withdrawal_request(self, params: dict[str, Any]) -> tuple[str, dict[str, Any], str]:
		"""The operation id and the member a withdrawal's every step names,
		bound by the fingerprint the caller computed — recomputed here."""
		operation_id = require_string(params.get("operationId"), "operationId", max_length=1_000)
		input_value = {
			"kind": "withdrawal",
			"profileId": require_string(params.get("profileId"), "profileId", max_length=1_000),
		}
		fingerprint = input_fingerprint(input_value)
		if params.get("fingerprint") != fingerprint:
			fail("FINGERPRINT_MISMATCH", "the withdrawal's fingerprint is not its member")
		return operation_id, input_value, fingerprint

	@staticmethod
	def _withdrawal(operation_id: str, fingerprint: str, state: str, **rest: Any) -> dict[str, Any]:
		return {"operationId": operation_id, "fingerprint": fingerprint, "state": state, **rest}

	def _settled_withdrawal(self, operation_id: str, fingerprint: str, entry: dict[str, Any]) -> dict[str, Any] | None:
		"""What an entry past its press already answers, or None for one a new
		attempt may start from (`RESOLVED_NOT_POSTED`)."""
		state = entry["state"]
		if state == "CONFIRMED":
			return self._withdrawal(operation_id, fingerprint, "confirmed", relationship=entry.get("relationship"))
		if state == "BLOCKED":
			return self._withdrawal(
				operation_id,
				fingerprint,
				"blocked",
				reason=str(entry.get("blockedReason") or "refused_after_withdraw"),
				detail=str(entry.get("error"))[:500],
				relationship=entry.get("relationship"),
			)
		if state in {"CLICKING", "UNCERTAIN"}:
			return self._withdrawal(
				operation_id,
				fingerprint,
				"uncertain",
				error=str(entry.get("error") or "a prior press may have reached LinkedIn; resolve it before anything else")[:500],
				relationship=entry.get("relationship"),
			)
		return None

	def _settle_withdrawal(self, operation_id: str, state: str, **fields: Any) -> dict[str, Any]:
		"""A withdrawal's entry settles as an invitation's does: its state and
		fields, its one-time token gone."""
		return self._settle_invitation(operation_id, state, **fields)

	async def _press_withdrawal(self, params: dict[str, Any]) -> dict[str, Any]:
		"""Withdraw, once, in one request: the member is re-read and the one
		control bound, the bound control re-validated and the account probed --
		pressing nothing that withdraws -- before the journal holds the attempt
		as CLICKING, durably; so a refusal pressed nothing and journaled
		nothing. An earlier attempt under the same id that reached its press
		answers for itself and is never pressed again. From CLICKING on,
		whatever goes wrong is uncertain and nothing under the id is pressed
		again."""
		operation_id, input_value, fingerprint = self._withdrawal_request(params)
		account_id = await self.backend.connected_account_id()
		entry = self._matching_entry(operation_id, fingerprint, account_id)
		settled = self._settled_withdrawal(operation_id, fingerprint, entry) if entry else None
		if settled is not None:
			return settled
		tag = secrets.token_hex(8)
		try:
			prepared = await self.backend.prepare_withdrawal(input_value, tag)
		except WithdrawalRefused as refused:
			return self._withdrawal(
				operation_id,
				fingerprint,
				"refused",
				reason=refused.reason,
				**({"detail": refused.detail[:500]} if refused.detail else {}),
			)
		await self.backend.validate_prepared_withdrawal(input_value, prepared)
		await self._assert_account_before_press(account_id)
		now = self.clock_ms()
		clicking = self._begin_click(
			operation_id,
			{
				"operationId": operation_id,
				"input": input_value,
				"fingerprint": fingerprint,
				"accountId": account_id,
				"attempt": int(entry.get("attempt") or 0) + 1 if entry else 1,
				"createdAt": entry.get("createdAt", now) if entry else now,
				"withdrawalPrepared": prepared,
				"relationship": None,
				"error": None,
			},
		)
		outcome: dict[str, Any] | None = None
		try:
			outcome = await self.backend.commit_prepared_withdrawal(clicking["input"], clicking["withdrawalPrepared"])
		except SidecarError as exc:
			error: SidecarError | None = exc
		except Exception as exc:  # a press may have reached LinkedIn
			error = SidecarError("WRITE_FAILED_AFTER_CLICK_START", str(exc))
		else:
			error = None

		state = (outcome or {}).get("state")
		relationship = (outcome or {}).get("relationship")
		if state == "confirmed":
			self._settle_withdrawal(operation_id, "CONFIRMED", relationship=relationship, error=None)
			return self._withdrawal(operation_id, fingerprint, "confirmed", relationship=relationship)
		if state in {"blocked", "connected"}:
			reason = "already_connected" if state == "connected" else "refused_after_withdraw"
			detail = str((outcome or {}).get("detail") or "the member is connected: the invitation was accepted")[:500]
			self._settle_withdrawal(operation_id, "BLOCKED", blockedReason=reason, error=detail, relationship=relationship)
			return self._withdrawal(operation_id, fingerprint, "blocked", reason=reason, detail=detail, relationship=relationship)
		message = (error.message if error is not None else str((outcome or {}).get("error") or "the withdrawal's outcome is unknown"))[:500]
		self._settle_withdrawal(
			operation_id,
			"UNCERTAIN",
			error=message,
			relationship=relationship,
			retryable=bool(error and error.retryable),
			rateLimited=bool(error and error.rate_limited),
		)
		return self._withdrawal(operation_id, fingerprint, "uncertain", error=message, relationship=relationship)

	async def _resolve_withdrawal(self, params: dict[str, Any]) -> dict[str, Any]:
		"""What became of an attempt nobody saw land, from a read of the member's
		profile in this session — never a press. An id that never reached its
		press withdrew nothing, and is closed so no later commit under it can
		press. A read still showing the invitation pending leaves the attempt
		open: whether that is long enough after the press to say nothing was
		withdrawn is the caller's to judge (`still_pending`)."""
		operation_id, input_value, fingerprint = self._withdrawal_request(params)
		account_id = await self.backend.connected_account_id()
		entry = self._matching_entry(operation_id, fingerprint, account_id)
		if entry is not None and entry["state"] in {"CONFIRMED", "BLOCKED"}:
			return self._settled_withdrawal(operation_id, fingerprint, entry)  # type: ignore[return-value]
		if entry is None or entry["state"] == "RESOLVED_NOT_POSTED":
			return self._withdrawal(operation_id, fingerprint, "resolved_not_sent", relationship=None)
		relationship = await self.backend.read_relationship(input_value["profileId"], None)
		member = input_value["profileId"].lower()
		admitted = (entry.get("withdrawalPrepared") or {}).get("relationship") or {}
		if withdrawn(relationship, member, admitted):
			self._settle_withdrawal(operation_id, "CONFIRMED", relationship=relationship, error=None)
			return self._withdrawal(operation_id, fingerprint, "confirmed", relationship=relationship)
		if member_connected(relationship, member, admitted):
			detail = "the member is connected: the invitation was accepted"
			self._settle_withdrawal(
				operation_id, "BLOCKED", blockedReason="already_connected", error=detail, relationship=relationship
			)
			return self._withdrawal(
				operation_id, fingerprint, "blocked", reason="already_connected", detail=detail, relationship=relationship
			)
		self._settle_withdrawal(operation_id, "UNCERTAIN", relationship=relationship)
		if still_pending(relationship, member, admitted):
			return self._withdrawal(operation_id, fingerprint, "still_pending", relationship=relationship)
		return self._withdrawal(
			operation_id,
			fingerprint,
			"uncertain",
			error="the profile's data shows the admitted member neither pending, withdrawn nor on Connect",
			relationship=relationship,
		)

	async def _withdraw_invitation(self, params: dict[str, Any]) -> dict[str, Any]:
		step = params.get("step")
		if step == "send":
			return await self._press_withdrawal(params)
		if step == "resolve":
			return await self._resolve_withdrawal(params)
		fail("INVALID_REQUEST", "step must be send or resolve")

	def _dm_request(self, params: dict[str, Any]) -> tuple[str, dict[str, Any], str]:
		"""The operation id and the content a DM's every step names: the
		conversation, the recipient and the words, bound by the fingerprint the
		caller computed over them — recomputed here, so the words typed are the
		words approved."""
		operation_id = require_string(params.get("operationId"), "operationId", max_length=1_000)
		thread_id = params.get("threadId")
		if not isinstance(thread_id, str) or not THREAD_ID_RE.fullmatch(thread_id):
			fail("INVALID_REQUEST", "threadId must be a LinkedIn messaging thread id")
		input_value = {
			"kind": "dm",
			"threadId": thread_id,
			"recipientProfileId": require_string(params.get("recipientProfileId"), "recipientProfileId", max_length=1_000),
			"text": require_string(params.get("text"), "text", max_length=MAX_DM_CHARS),
		}
		fingerprint = input_fingerprint(input_value)
		if params.get("fingerprint") != fingerprint:
			fail("FINGERPRINT_MISMATCH", "the message's fingerprint is not its conversation, recipient and words")
		return operation_id, input_value, fingerprint

	@staticmethod
	def _dm(operation_id: str, fingerprint: str, state: str, **rest: Any) -> dict[str, Any]:
		return {"operationId": operation_id, "fingerprint": fingerprint, "state": state, **rest}

	def _settled_dm(self, operation_id: str, fingerprint: str, entry: dict[str, Any]) -> dict[str, Any] | None:
		"""What an entry past its press already answers, or None for one a new
		attempt may start from (`RESOLVED_NOT_POSTED`)."""
		state = entry["state"]
		if state == "CONFIRMED":
			return self._dm(operation_id, fingerprint, "confirmed", receipt=entry["receipt"])
		if state == "BLOCKED":
			return self._dm(
				operation_id, fingerprint, "blocked", reason="refused_after_send", detail=str(entry.get("error"))[:500]
			)
		if state in {"CLICKING", "UNCERTAIN"}:
			return self._dm(
				operation_id,
				fingerprint,
				"uncertain",
				error=str(entry.get("error") or "a prior Send may have reached LinkedIn; resolve it before anything else")[:500],
			)
		return None

	def _settle_dm(self, operation_id: str, state: str, **fields: Any) -> dict[str, Any]:
		def settle(current: dict[str, Any]) -> dict[str, Any]:
			current.update(
				{
					"state": state,
					"updatedAt": self.clock_ms(),
					"confirmationTokenHash": None,
					"expiresAt": None,
					**fields,
				}
			)
			return current

		return self.journal.mutate(operation_id, settle)

	async def _press_dm(self, params: dict[str, Any]) -> dict[str, Any]:
		"""Send, once, in one request -- see `_send_dm_write`. The conversation is
		read afresh, held to the recipient by the member urn it is bound to and
		to the message it was written after, and nothing is written."""
		operation_id, input_value, fingerprint = self._dm_request(params)
		expected = require_object(params.get("expected"), "expected")
		after = require_string(expected.get("lastMessageId"), "expected.lastMessageId", max_length=1_000)
		member_urn = expected.get("memberUrn")
		if member_urn is not None and (not isinstance(member_urn, str) or not MEMBER_URN_RE.fullmatch(member_urn)):
			fail("INVALID_REQUEST", "expected.memberUrn must be the recipient's member urn")
		account_id = await self.backend.connected_account_id()
		entry = self._matching_entry(operation_id, fingerprint, account_id)
		settled = self._settled_dm(operation_id, fingerprint, entry) if entry else None
		if settled is not None:
			return settled
		try:
			prepared = await self.backend.prepare_dm(
				input_value,
				{"lastMessageId": after, **({"memberUrn": member_urn} if member_urn else {})},
				origin_token(operation_id),
			)
		except DmRefused as refused:
			return self._refused_dm(operation_id, fingerprint, refused.reason, refused.detail)
		await self.backend.validate_prepared_dm(input_value, prepared)
		return await self._send_dm_write(
			operation_id, input_value, fingerprint, account_id, entry, prepared,
				press=lambda clicking: self.backend.commit_prepared_dm(clicking["input"], clicking["dmPrepared"]),
			kept=("receipt",),
			expectedLastMessageId=after,
		)

	def _refused_dm(self, operation_id: str, fingerprint: str, reason: str, detail: str | None) -> dict[str, Any]:
		"""A refusal before anything was sent, as a DM's send answers it."""
		return self._dm(
			operation_id, fingerprint, "refused", reason=reason, **({"detail": detail[:500]} if detail else {})
		)

	async def _press_open_dm(self, params: dict[str, Any]) -> dict[str, Any]:
		"""Send a first message, once, in one request, on a DM's terms
		(`_send_dm_write`); a confirmation carries the conversation it opened
		beside the receipt."""
		operation_id, input_value, fingerprint = self._open_dm_request(params)
		account_id = await self.backend.connected_account_id()
		entry = self._matching_entry(operation_id, fingerprint, account_id)
		settled = self._settled_open_dm(operation_id, fingerprint, entry) if entry else None
		if settled is not None:
			return settled
		try:
			prepared = await self.backend.prepare_open_dm(input_value, origin_token(operation_id))
		except OpenDmRefused as refused:
			return self._refused_dm(operation_id, fingerprint, refused.reason, refused.detail)
		await self.backend.validate_prepared_dm(input_value, prepared)
		return await self._send_dm_write(
			operation_id, input_value, fingerprint, account_id, entry, prepared,
			press=lambda clicking: self.backend.commit_prepared_open_dm(
				clicking["input"], clicking["dmPrepared"], int(clicking["clickStartedAt"])
			),
			kept=("receipt", "conversation"),
			conversation=None,
		)

	async def _send_dm_write(
		self,
		operation_id: str,
		input_value: dict[str, Any],
		fingerprint: str,
		account_id: str,
		earlier: dict[str, Any] | None,
		prepared: dict[str, Any],
		*,
		press: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
		kept: tuple[str, ...],
		**more: Any,
	) -> dict[str, Any]:
		"""Send, once. The account is probed again before the journal holds the
		attempt as CLICKING, durably -- so a refusal before it sent nothing and
		journaled nothing; from CLICKING on, whatever goes wrong is uncertain
		and nothing under the id is sent again. A confirmation settles with, and
		answers with, the fields of the outcome named in `kept`; a refusal and an
		uncertain outcome keep what LinkedIn answered, in words."""
		await self._assert_account_before_press(account_id)
		now = self.clock_ms()
		clicking = self._begin_click(
			operation_id,
			{
				"operationId": operation_id,
				"input": input_value,
				"fingerprint": fingerprint,
				"accountId": account_id,
				"attempt": int(earlier.get("attempt") or 0) + 1 if earlier else 1,
				"createdAt": earlier.get("createdAt", now) if earlier else now,
				"dmPrepared": prepared,
				"receipt": None,
				"error": None,
				**more,
			},
		)
		outcome: dict[str, Any] | None = None
		try:
			outcome = await press(clicking)
		except SidecarError as exc:
			error: SidecarError | None = exc
		except Exception as exc:  # the press may have reached LinkedIn
			error = SidecarError("WRITE_FAILED_AFTER_CLICK_START", str(exc))
		else:
			error = None

		if outcome is not None and outcome.get("state") == "confirmed":
			confirmed = {name: outcome[name] for name in kept}
			self._settle_dm(operation_id, "CONFIRMED", error=None, **confirmed)
			return self._dm(operation_id, fingerprint, "confirmed", **confirmed)
		if outcome is not None and outcome.get("state") == "blocked":
			detail = str(outcome.get("detail") or "LinkedIn refused the message")[:500]
			self._settle_dm(operation_id, "BLOCKED", error=detail)
			return self._dm(operation_id, fingerprint, "blocked", reason="refused_after_send", detail=detail)
		message = (error.message if error is not None else str((outcome or {}).get("error") or "Send's outcome is unknown"))[:500]
		self._settle_dm(
			operation_id,
			"UNCERTAIN",
			error=message,
			retryable=bool(error and error.retryable),
			rateLimited=bool(error.rate_limited) if error is not None else (outcome or {}).get("rateLimited") is True,
		)
		return self._dm(operation_id, fingerprint, "uncertain", error=message)

	def _answered_without_read(
		self,
		operation_id: str,
		fingerprint: str,
		entry: dict[str, Any] | None,
		settled_by: Callable[[str, str, dict[str, Any]], dict[str, Any] | None],
	) -> dict[str, Any] | None:
		"""What a resolve answers before any read: a settled attempt for itself,
		and an id that never reached Send as `resolved_not_sent` — closed, so no
		later commit under it can press. None for an attempt a read may settle."""
		if entry is not None and entry["state"] in {"CONFIRMED", "BLOCKED"}:
			return settled_by(operation_id, fingerprint, entry)
		if entry is None or entry["state"] == "RESOLVED_NOT_POSTED":
			return self._dm(operation_id, fingerprint, "resolved_not_sent")
		return None

	async def _resolve_dm(self, params: dict[str, Any]) -> dict[str, Any]:
		"""What became of an attempt nobody saw land, from the conversation read
		afresh in this session — its history where it answers, else its page
		(`backend.dm_read_back`) — never a press. Our message after the one the
		DM was written after is the receipt. Nothing sent is left to the caller
		to weigh against the time since the press, from a history whose newest
		message is still that one (`absent`). A page read that does not show the
		message proves nothing — not even the words still in the composer, which
		is client state LinkedIn restores as a draft — and stays uncertain. An
		id that never reached Send sent nothing, and is closed so no later
		commit under it can press."""
		operation_id, input_value, fingerprint = self._dm_request(params)
		members = known_members(params.get("members"))
		account_id = await self.backend.connected_account_id()
		entry = self._matching_entry(operation_id, fingerprint, account_id)
		answered = self._answered_without_read(operation_id, fingerprint, entry, self._settled_dm)
		if answered is not None:
			return answered
		assert entry is not None
		after = str(entry.get("expectedLastMessageId") or "")
		read, from_history = await self.backend.dm_read_back(input_value["threadId"], members, limit=MAX_HISTORY_MESSAGES)
		message = sent_message(read, after=after, text=input_value["text"])
		if message is not None:
			found = receipt(read, message)
			self._settle_dm(operation_id, "CONFIRMED", receipt=found, error=None)
			return self._dm(operation_id, fingerprint, "confirmed", receipt=found)
		self._settle_dm(operation_id, "UNCERTAIN")
		return self._dm(
			operation_id,
			fingerprint,
			"uncertain",
			error="the conversation does not show the message",
			absent=from_history and ends_at(read, after),
			observedAt=read["observedAt"],
		)

	def _open_dm_request(self, params: dict[str, Any]) -> tuple[str, dict[str, Any], str]:
		"""What a first message's every step names: the member and the words,
		bound by the fingerprint the caller computed over them."""
		operation_id = require_string(params.get("operationId"), "operationId", max_length=1_000)
		input_value = {
			"kind": "open_dm",
			"recipientProfileId": require_string(params.get("recipientProfileId"), "recipientProfileId", max_length=1_000),
			"text": require_string(params.get("text"), "text", max_length=MAX_DM_CHARS),
		}
		fingerprint = input_fingerprint(input_value)
		if params.get("fingerprint") != fingerprint:
			fail("FINGERPRINT_MISMATCH", "the message's fingerprint is not its recipient and words")
		return operation_id, input_value, fingerprint

	def _settled_open_dm(self, operation_id: str, fingerprint: str, entry: dict[str, Any]) -> dict[str, Any] | None:
		"""As `_settled_dm`, a confirmation carrying the conversation it opened."""
		if entry["state"] == "CONFIRMED":
			return self._dm(
				operation_id, fingerprint, "confirmed", receipt=entry["receipt"], conversation=entry["conversation"]
			)
		return self._settled_dm(operation_id, fingerprint, entry)

	async def _resolve_open_dm(self, params: dict[str, Any]) -> dict[str, Any]:
		"""What became of a first message nobody saw land, from the account's
		conversation list read afresh — never a press. A 1:1 with the member
		whose history shows our words since the press is the receipt. No such
		conversation in a list whole since the press is `absent`, which the
		caller weighs against the time since the press; anything else stays
		uncertain. An id that never reached Send sent nothing, and is closed."""
		operation_id, input_value, fingerprint = self._open_dm_request(params)
		account_id = await self.backend.connected_account_id()
		entry = self._matching_entry(operation_id, fingerprint, account_id)
		answered = self._answered_without_read(operation_id, fingerprint, entry, self._settled_open_dm)
		if answered is not None:
			return answered
		assert entry is not None
		since = int(entry.get("clickStartedAt") or entry.get("updatedAt") or 0)
		recipient = input_value["recipientProfileId"]
		read, absent = await self.backend.open_dm_read_back(recipient, entry["dmPrepared"]["profileUrn"], since)
		message = None if read is None else opened_message(read, recipient=recipient, text=input_value["text"], since_ms=since)
		if read is not None and message is not None:
			found, conversation = opened_receipt(read, message), conversation_of(read)
			self._settle_dm(operation_id, "CONFIRMED", receipt=found, conversation=conversation, error=None)
			return self._dm(operation_id, fingerprint, "confirmed", receipt=found, conversation=conversation)
		self._settle_dm(operation_id, "UNCERTAIN")
		return self._dm(
			operation_id,
			fingerprint,
			"uncertain",
			error="the conversation list does not show the message",
			absent=absent,
			observedAt=self.clock_ms(),
		)

	async def _open_dm(self, params: dict[str, Any]) -> dict[str, Any]:
		step = params.get("step")
		if step == "send":
			return await self._press_open_dm(params)
		if step == "resolve":
			return await self._resolve_open_dm(params)
		fail("INVALID_REQUEST", "step must be send or resolve")

	async def _send_dm(self, params: dict[str, Any]) -> dict[str, Any]:
		step = params.get("step")
		if step == "send":
			return await self._press_dm(params)
		if step == "resolve":
			return await self._resolve_dm(params)
		fail("INVALID_REQUEST", "step must be send or resolve")

	async def dispatch(self, op: str, params: dict[str, Any]) -> dict[str, Any]:
		# Writes -- a comment, a reply, a like, an invitation, a DM -- are
		# external actions on the real account. The sidecar holds no gate of its
		# own for them: the owner's live-writes switch is the one gate, read when
		# a driver is built, and a driver built without it never sends the
		# request (`driver.ts`). The journaled ones are one `write` or `send`
		# request each, which journals CLICKING before the POST; a like needs no
		# journal: the post's data and both like scripts refuse anything but an
		# unpressed control, so a re-run after a crash cannot toggle a like back
		# off, and `read_like_state` reads what one did without pressing.
		# Any unattended op is proof the owner's sign-in moment is over: re-hide
		# a window an interactive probe surfaced. Persistent Chrome made this
		# necessary — the window used to die with the job that unhid it. The
		# interactive probe itself is exempt (it is ABOUT to unhide), so is the
		# owner's own window ops (they decide the window themselves, a restart
		# among them), and shutdown touches no window.
		if op not in {"warm_browser", "shutdown", "set_window_visibility", "restart_browser", "close_browser"} and not (
			op == "ensure_session" and (params.get("interactive") is True or params.get("existingPageOnly") is True)
		):
			# The owner is typing a sign-in on the page this op would navigate.
			# It would find nobody signed in, and is told so without taking the
			# page; a probe only reads the page, so it still looks.
			if op != "ensure_session" and self.backend.signing_in():
				fail("LOGIN_REQUIRED", "login_required")
			await self.backend.rehide_if_needed()
		if op == "warm_browser":
			if params:
				fail("INVALID_REQUEST", "warm_browser takes no params")
			return await self.backend.warm_browser()
		if op == "ensure_session":
			if params.get("existingPageOnly") is True:
				if len(params) != 1:
					fail("INVALID_REQUEST", "existingPageOnly takes no window options")
				return await self.backend.observe_session()
			interactive = params.get("interactive", False)
			if not isinstance(interactive, bool):
				fail("INVALID_REQUEST", "interactive must be a boolean")
			# Only what the caller named is passed on: a probe that names nothing
			# else is the probe this op has always been.
			extra: dict[str, Any] = {}
			for key, name in (("surface", "surface"), ("signIn", "sign_in")):
				if key in params:
					if not isinstance(params[key], bool):
						fail("INVALID_REQUEST", f"{key} must be a boolean")
					extra[name] = params[key]
			if "place" in params:
				extra["place"] = window_place(params["place"])
			return await self.backend.ensure_session(interactive=interactive, **extra)
		if op == "set_window_visibility":
			window = params.get("window")
			reveal = params.get("reveal")
			if (window is None) == (reveal is None):
				fail("INVALID_REQUEST", "pass exactly one of window and reveal")
			if window is not None and window not in {"hidden", "shown"}:
				fail("INVALID_REQUEST", "window must be hidden or shown")
			if reveal is not None and reveal is not True:
				fail("INVALID_REQUEST", "reveal must be true")
			if "place" in params and reveal is None:
				fail("INVALID_REQUEST", "place goes with reveal")
			place = {"place": window_place(params["place"])} if "place" in params else {}
			return await self.backend.set_window_visibility(window, reveal=reveal is True, **place)
		if op == "restart_browser":
			if set(params) - {"place"}:
				fail("INVALID_REQUEST", "restart_browser takes only place")
			place = {"place": window_place(params["place"])} if "place" in params else {}
			return await self.backend.restart_browser(**place)
		if op == "close_browser":
			if params:
				fail("INVALID_REQUEST", "close_browser takes no params")
			# The browser alone: the sidecar stays, and the next operation starts
			# one on whatever profile is at the path by then.
			await self.backend.shutdown()
			return {"ok": True}
		if op == "discover_posts":
			term = require_string(params.get("term"), "term", max_length=1_000)
			kind = params.get("kind", "search")
			if kind not in {"search", "author"}:
				fail("INVALID_REQUEST", "kind must be search or author")
			date_posted = params.get("datePosted")
			if date_posted not in {None, "past_day", "past_week", "past_month"}:
				fail("INVALID_REQUEST", "datePosted is invalid")
			sort = params.get("sort")
			if sort not in {None, "relevance", "latest"}:
				fail("INVALID_REQUEST", "sort is invalid")
			cursor = params.get("cursor")
			if cursor is not None:
				cursor = require_string(cursor, "cursor", max_length=100_000)
			return await self.backend.discover_posts(
				{
					"term": term,
					"kind": kind,
					"datePosted": date_posted,
					"sort": sort,
					"cursor": cursor,
					"limit": optional_limit(params.get("limit"), default=10, maximum=100),
				}
			)
		if op == "fetch_own_profile":
			return {"profile": await self.backend.fetch_own_profile()}
		if op == "fetch_own_posts":
			posts = await self.backend.fetch_own_posts(optional_limit(params.get("limit"), default=25, maximum=100))
			# Set when the sweep ran out of pages before the limit: a short list
			# that is not the whole of what the account wrote.
			return {"posts": posts, **({"incomplete": True} if getattr(self.backend, "author_posts_cut_short", False) else {})}
		if op == "fetch_own_comments":
			read = await self.backend.fetch_own_comments(optional_limit(params.get("limit"), default=50, maximum=100))
			# Set when the pages ran out before the limit: a short list that is
			# not the whole of what the account wrote.
			return {"comments": read.comments, **({"incomplete": True} if read.incomplete else {})}
		if op == "write":
			return await self._write(params)
		if op == "reconcile_posted":
			return await self._reconcile_posted(params)
		if op == "resolve_write_outcome":
			return await self._resolve_write_outcome(params)
		if op == "settle_member_write":
			return await self._settle_member_write(params)
		if op == "like_post":
			post_urn = require_string(params.get("postUrn"), "postUrn", max_length=1_000)
			return {"outcome": await self.backend.like_post(post_urn)}
		if op == "like_comment":
			post_urn = require_string(params.get("postUrn"), "postUrn", max_length=1_000)
			comment_urn = require_string(params.get("commentUrn"), "commentUrn", max_length=1_000)
			parent_urn = optional_string(params.get("parentCommentUrn"), "parentCommentUrn", max_length=1_000)
			return {"outcome": await self.backend.like_comment(post_urn, comment_urn, parent_urn)}
		if op == "read_like_state":
			post_urn = require_string(params.get("postUrn"), "postUrn", max_length=1_000)
			comment_urn = optional_string(params.get("commentUrn"), "commentUrn", max_length=1_000)
			parent_urn = optional_string(params.get("parentCommentUrn"), "parentCommentUrn", max_length=1_000)
			if parent_urn is not None and comment_urn is None:
				fail("INVALID_REQUEST", "parentCommentUrn needs the commentUrn of the reply it is the parent of")
			return await self.backend.read_like_state(post_urn, comment_urn, parent_urn)
		if op == "read_post_thread":
			post_urn = require_string(params.get("postUrn"), "postUrn", max_length=1_000)
			max_comments = params.get("maxComments", 20)
			if isinstance(max_comments, bool) or not isinstance(max_comments, int) or not 0 <= max_comments <= 50:
				fail("INVALID_REQUEST", "maxComments must be an integer between 0 and 50")
			order = params.get("order", "RELEVANCE")
			start = params.get("start", 0)
			if order not in ("RELEVANCE", "REVERSE_CHRONOLOGICAL"):
				fail("INVALID_REQUEST", "order must be RELEVANCE or REVERSE_CHRONOLOGICAL")
			if isinstance(start, bool) or not isinstance(start, int) or not 0 <= start <= 100:
				fail("INVALID_REQUEST", "start must be an integer between 0 and 100")
			return await self.backend.read_post_thread(post_urn, max_comments, order, start)
		if op == "read_author_profile":
			profile_id = require_string(params.get("profileId"), "profileId", max_length=1_000)
			return await self.backend.read_author_profile(profile_id, params.get("role") is True)
		if op == "read_company_page":
			company_ref = require_string(params.get("companyRef"), "companyRef", max_length=1_000)
			return await self.backend.read_company_page(company_ref)
		if op == "read_comment_replies":
			post_urn = require_string(params.get("postUrn"), "postUrn", max_length=1_000)
			comment_urn = require_string(params.get("commentUrn"), "commentUrn", max_length=1_000)
			since = params.get("since")
			if since is not None and (isinstance(since, bool) or not isinstance(since, int) or since < 0):
				fail("INVALID_REQUEST", "since must be a non-negative integer of epoch ms")
			limit = params.get("limit")
			if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
				fail("INVALID_REQUEST", "limit must be an integer between 1 and 100")
			vouched = params.get("vouchedReplyUrns", [])
			if (
				not isinstance(vouched, list)
				or len(vouched) > MAX_VOUCHED_REPLIES
				or not all(isinstance(urn, str) and comment_id(urn) is not None for urn in vouched)
			):
				fail("INVALID_REQUEST", f"vouchedReplyUrns must be at most {MAX_VOUCHED_REPLIES} comment urns")
			if "roomReplyUrn" in params:
				room_reply_urn = require_string(params["roomReplyUrn"], "roomReplyUrn", max_length=1_000)
				return await self.backend.read_comment_replies(post_urn, comment_urn, since, limit, frozenset(vouched), room_reply_urn)
			return await self.backend.read_comment_replies(post_urn, comment_urn, since, limit, frozenset(vouched))
		if op == "read_notifications":
			start = params.get("start")
			if isinstance(start, bool) or not isinstance(start, int) or not 0 <= start <= MAX_NOTIFICATION_START:
				fail("INVALID_REQUEST", f"start must be an integer between 0 and {MAX_NOTIFICATION_START}")
			return await self.backend.read_notifications(start)
		if op == "read_relationship":
			profile_id = params.get("profileId")
			profile_url = params.get("profileUrl")
			if (profile_id is None) == (profile_url is None):
				fail("INVALID_REQUEST", "pass exactly one of profileId and profileUrl")
			if profile_id is not None:
				profile_id = require_string(profile_id, "profileId", max_length=1_000)
			else:
				profile_url = require_string(profile_url, "profileUrl", max_length=1_000)
			place = params.get("place", False)
			if not isinstance(place, bool):
				fail("INVALID_REQUEST", "place must be a boolean")
			return await self.backend.read_relationship(profile_id, profile_url, place)
		if op == "read_incoming_invitations":
			since = params.get("since")
			if since is not None and (isinstance(since, bool) or not isinstance(since, int) or since < 0):
				fail("INVALID_REQUEST", "since must be a non-negative integer of epoch ms")
			limit = params.get("limit")
			if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_INVITATIONS:
				fail("INVALID_REQUEST", f"limit must be an integer between 1 and {MAX_INVITATIONS}")
			return await self.backend.read_incoming_invitations(since, limit)
		if op == "accept_invitation":
			return await self._accept_invitation(params)
		if op == "read_inbox":
			since = params.get("since")
			if since is not None and (isinstance(since, bool) or not isinstance(since, int) or since < 0):
				fail("INVALID_REQUEST", "since must be a non-negative integer of epoch ms")
			limit = params.get("limit")
			if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50:
				fail("INVALID_REQUEST", "limit must be an integer between 1 and 50")
			return await self.backend.read_inbox(since, limit)
		if op == "read_dm_thread":
			thread_id = params.get("threadId")
			if not isinstance(thread_id, str) or not THREAD_ID_RE.fullmatch(thread_id):
				fail("INVALID_REQUEST", "threadId must be a LinkedIn messaging thread id")
			since = params.get("since")
			if since is not None and (isinstance(since, bool) or not isinstance(since, int) or since < 0):
				fail("INVALID_REQUEST", "since must be a non-negative integer of epoch ms")
			restore_unread = params.get("restoreUnread", False)
			if not isinstance(restore_unread, bool):
				fail("INVALID_REQUEST", "restoreUnread must be a boolean")
			return await self.backend.read_dm_thread(thread_id, since, restore_unread=restore_unread)
		if op == "read_conversation_messages":
			thread_id = params.get("threadId")
			if not isinstance(thread_id, str) or not THREAD_ID_RE.fullmatch(thread_id):
				fail("INVALID_REQUEST", "threadId must be a LinkedIn messaging thread id")
			limit = params.get("limit")
			if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_HISTORY_MESSAGES:
				fail("INVALID_REQUEST", f"limit must be an integer between 1 and {MAX_HISTORY_MESSAGES}")
			return await self.backend.read_conversation_messages(thread_id, limit, known_members(params.get("members")))
		if op == "read_page_for_agent":
			# A read, of the one page its intent names: never an address the
			# caller chose.
			target = agent_read_target(params.get("intent"), params.get("url"), params.get("commentUrn"))
			return await self.backend.read_page_for_agent(target)
		if op == "send_invitation":
			return await self._send_invitation(params)
		if op == "withdraw_invitation":
			return await self._withdraw_invitation(params)
		if op == "send_dm":
			return await self._send_dm(params)
		if op == "open_dm":
			return await self._open_dm(params)
		if op == "shutdown":
			await self.backend.shutdown()
			self.stopped = True
			return {"ok": True}
		fail("UNKNOWN_OPERATION", f"unsupported operation: {op}")

	async def handle_request(self, value: Any) -> dict[str, Any]:
		request_id = "unknown"
		op = "unknown"
		try:
			request = require_object(value, "request")
			request_id = require_string(request.get("id"), "id", max_length=1_000)
			op = require_string(request.get("op"), "op", max_length=100)
			if request.get("v") != PROTOCOL_VERSION:
				fail("UNSUPPORTED_PROTOCOL", f"expected protocol v{PROTOCOL_VERSION}")
			if op not in SUPPORTED_OPS:
				fail("UNKNOWN_OPERATION", f"unsupported operation: {op}")
			params = require_object(request.get("params"), "params")
			result = await self.dispatch(op, params)
			return success_response(request_id, op, result)
		except SidecarError as exc:
			return error_response(request_id, op, exc)
		except Exception as exc:
			return error_response(request_id, op, SidecarError("INTERNAL_ERROR", str(exc), retryable=False))

	async def close(self) -> None:
		try:
			await self.backend.shutdown()
		finally:
			self.journal.close()
