"""Pinned, deterministic backend for LinkedIn's rendered UI.

Chromium is driven over CDP directly (`chromium.py`, on `cdp-use`): launch or
attach, tabs, page functions, navigation and the network events a read listens
to. No agent, prompt-based element selection or DOM index is in this trust
boundary.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import importlib.metadata
import json
import os
import plistlib
import random
import re
import signal
import subprocess
import sys
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol
from urllib.parse import quote, urlencode, urlparse

from .agent_page import AgentReadTarget, json_representation, on_post_page, page_representation
from .room_reply_write import check_room_parent, reconciled_room_reply
from .capture import DOCUMENT_TYPES, CapturedResponse, NetworkTap, ResponseCapture, response_json, response_text
from .comment_write import (
	CREATE_COMMENT_PATH,
	NORMALIZED_JSON,
	PAGE_POST_JS,
	REACTION_BODY,
	PostThread,
	answer_fingerprint,
	comment_link_query,
	comment_outcome,
	comment_thread,
	create_comment_body,
	post_record,
	post_thread,
	reaction_outcome,
	reaction_path,
)
from .comment_write import SEND_TIMEOUT_MS as COMMENT_SEND_TIMEOUT_MS
from .comment_data import (
	COMMENT_DATA_PAGES,
	POST_COMMENT_ORDERS,
	POST_COMMENT_PAGES,
	DataPage,
	OwnComment,
	comment_data_address,
	comment_data_page,
	comment_data_replies,
	data_reply_reaction,
	find_own_comment,
	post_comments_address,
	post_comments_page,
	wants_next_page,
)
from .conversations import (
	COMPOSE_URL,
	CONVERSATIONS_RE,
	HISTORY_PAGE,
	LATEST_MESSAGES_QUERY,
	ME_RE,
	OLDER_MESSAGES_QUERY,
	PAGE_HEADERS,
	PROFILE_URN_PREFIX,
	HistoryUnavailable,
	account_mailbox,
	conversation_history,
	conversation_list,
	conversation_urn,
	history_path,
	messages_query,
	response_fingerprint,
)
from .dm_open import (
	CLOCK_SKEW_MS as OPEN_DM_CLOCK_SKEW_MS,
	COMPOSE_CONTEXT_RE,
	COMPOSE_OPTIONS_RE,
	COMPOSE_PATH,
	RECIPIENT_CONVERSATIONS_RE,
	compose_address,
	compose_evidence_for,
	conversation_of,
	existing_conversation,
	lookup_conversations,
	opened_message,
)
from .dm_open import Refused as OpenDmRefused
from .dm_open import admit as admit_open_dm
from .dm_open import admit_binding as admit_compose_binding
from .dm_write import (
	CREATE_MESSAGE_PATH,
	DM_SNAPSHOT_JS,
	SEND_MESSAGE_JS,
	SEND_TIMEOUT_MS,
	SESSION_COOKIE_JS,
	DmSnapshot,
	create_message_body,
	dm_snapshot_from_page,
	posted_receipt,
	refusal_shown,
	send_outcome,
	wire_body,
)
from .dm_write import Refused as DmRefused
from .dm_write import admit as admit_dm
from .experience import EXPERIENCE_JS, SCROLL_TO_EXPERIENCE_JS, TRACES_JS, current_role
from .invitation_write import (
	COMPOSE_VIEW_PATH,
	CREATE_INVITATION_PATH,
	SEND_INVITATION_JS,
	admit,
	admit_member,
	admit_note,
	compose_view,
	create_invitation_body,
	invitation_receipt,
	sent,
)
from .invitation_write import Refused as InvitationRefused
from .invitation_write import SEND_TIMEOUT_MS as INVITATION_SEND_TIMEOUT_MS
from .invitation_write import send_outcome as invitation_outcome
from .invitation_write import wire_body as invitation_wire_body
from .invitation_withdraw import (
	CONFIRM_WITHDRAW_JS,
	INVITATION_SNAPSHOT_JS,
	KEYED_SNAPSHOT_JS,
	MORE_CONTROL_RE,
	PRESS_MORE_JS,
	PRESS_PENDING_JS,
	TAG_PENDING_JS,
	WITHDRAW_LABEL_RE,
	WITHDRAW_WORDS_RE,
	after_withdraw,
	bound_control,
	invitation_snapshot_from_page,
	keyed_control,
	keyed_snapshot_from_page,
	more_control,
	pending_key,
	withdraw_confirmation,
	withdrawn,
)
from .invitation_withdraw import admit as admit_withdrawal
from .invitation_withdraw import connected as connected_member
from .invitation_accept import (
	ACCEPT_CONTROL_RE,
	ACCEPT_SNAPSHOT_JS,
	PRESS_ACCEPT_JS,
	TAG_ACCEPT_JS,
	accept_control,
	accept_left,
	accept_snapshot_from_page,
	bound_accept,
	connected as sender_connected,
	invitation_absent,
	listed,
	row_key,
)
from .invitation_accept import admit as admit_acceptance
from .invitations import INVITATIONS_URL
from .invitations_data import INVITATIONS_DOCUMENT_RE, ReceivedInvitations, invitations_read, received_invitations
from .like_attempt import LikeAttempt, pressed_nothing
from .like_data import DEFAULT as NO_REACTION
from .like_data import LIKE, combined_reaction, document_reaction, reply_link_query
from .member_relationship import MemberRelationship, member_relationship, top_card_path
from .messaging import (
	LANDED_JS,
	MARK_UNREAD_JS,
	MESSAGING_SNAPSHOT_JS,
	OPEN_CARD_MENU_JS,
	PRESS_CARD_JS,
	THREAD_ID_RE,
	UnreadRestore,
	card_menu_args,
	card_shows_unread,
	dm_thread_read,
	inbox_rendered,
	landed_args,
	mark_unread_args,
	messaging_snapshot_from_page,
	press_card_args,
	press_landed,
	thread_id_of,
	thread_page,
	thread_rendered,
	unread_restore,
)
from .notifications import DEFAULT_NOTIFICATION_CARDS_ADDRESS, NOTIFICATION_CARDS_RE, notification_cards, page_address
from .page_visit import PageIdentity, PageVisit, RscPageHeaders, same_page
from .own_comments import PAGINATION_PATH, OwnCommentsRead, PageRequest, PageUnavailable, read_own_comments
from .profile_data import (
	MEMBER_ID_RE,
	Own,
	OwnProfile,
	ProfileData,
	document_values,
	own_profile,
	profile_data,
	topcard_key,
)
from .protocol import CDP_USE_VERSION, SELECTOR_PACK_VERSION, SidecarError
from .receipt_log import ReceiptLog, receipt_log
from .relationship import (
	MEMBER_URL_PREFIX,
	PROFILE_SNAPSHOT_JS,
	ProfileSnapshot,
	card_of,
	member_page,
	profile_snapshot_from_page,
	relationship_read,
)
from .replies import (
	EXPAND_REPLIES_JS,
	SNAPSHOT_JS,
	ThreadReading,
	clean,
	comment_id,
	comment_replies,
	expand_replies_args,
	page_fingerprint,
	profile_identity,
	read_thread,
	snapshot_from_page,
)
from .reply_write import (
	REPLY_READ_LIMIT,
	check_reply_target,
	own_reply,
	own_reply_urns,
	reconciled_reply,
	reply_denied,
	reply_parent,
)
from .thread_data import (
	PAGE_DATA_JS,
	PageThreads,
	Unrecognised,
	flight_from_page,
	flight_values,
	page_threads,
	script_from_document,
)
from .voyager import (
	RECENT_POSTS_MAX,
	VoyagerUnavailable,
	comment_thread_ref,
	owner_verdict,
	own_display_name,
	own_headline,
	own_member_id,
	own_numeric_member_id,
	own_public_identifier,
	member_place,
	company_slug,
	parse_author_profile,
	parse_company_page,
	parse_post_thread,
	parse_updates,
	profile_slug,
)
from .window import read_choice, record_hide

if TYPE_CHECKING:
	from .chromium import Chromium, Page

# Same-origin fetch of LinkedIn's own JSON API from the page already loaded. The
# browser supplies the session cookies, so no credential is ever handled here.
# Returns an envelope rather than throwing so the caller can classify the
# failure and fall back to the DOM.
# One page of a conversation's history, fetched as the messaging page's own
# client fetches it: a GET, the page's own headers beside the CSRF token, and
# nothing else — no write, no receipt.
HISTORY_FETCH_JS = r"""(path, pageHeaders) => (async () => {
  const jsession = (document.cookie.match(/JSESSIONID="?([^";]+)"?/) || [])[1] || '';
  try {
    const res = await fetch(path, {
      method: 'GET',
      credentials: 'include',
      headers: {
        ...JSON.parse(pageHeaders),
        'csrf-token': jsession,
        'accept': 'application/graphql',
        'x-restli-protocol-version': '2.0.0',
      },
    });
    const body = await res.text();
    return JSON.stringify({ ok: res.ok, status: res.status, body });
  } catch (e) {
    return JSON.stringify({ ok: false, status: 0, error: String(e) });
  }
})()"""

# Whether the page holds the session cookie VOYAGER_FETCH_JS signs a request
# with — its csrf token. Reads one cookie's presence, never its value.
SEARCH_SESSION_JS = r"""() => (/JSESSIONID="?[^";]+/.test(document.cookie) ? 'ready' : 'waiting')"""

VOYAGER_FETCH_JS = r"""(path) => (async () => {
  const jsession = (document.cookie.match(/JSESSIONID="?([^";]+)"?/) || [])[1] || '';
  try {
    const res = await fetch(path, {
      credentials: 'include',
      headers: {
        'csrf-token': jsession,
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'x-restli-protocol-version': '2.0.0',
      },
    });
    const body = await res.text();
    return JSON.stringify({
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      body,
    });
  } catch (e) {
    return JSON.stringify({ ok: false, status: 0, error: String(e) });
  }
})()"""


def _has_chrome_segment(value: str) -> bool:
	"""True when some path segment contains "chrome" (any case) -- the
	shape of a real Chrome install, which the pinned build never is."""
	return any("chrome" in segment.lower() for segment in Path(value).parts)


# The one build setup downloads (US-OND-04): Playwright's chromium 1179,
# frozen in `packages/cli/bin/lib/browserManifest.mjs` (`BROWSER_BUILD`),
# whose sha256 vouches for the bytes before they are unpacked. The sidecar
# accepts exactly that build at exactly its installed path -- any other
# build is a browser nobody verified, so there is no glob, no "newest
# wins", and no honouring a named path anywhere else.
PINNED_BROWSER_BUILD = "1179"


def _pinned_browser_executable() -> Path:
	return Path(
		f"~/.engager/browser/chromium-{PINNED_BROWSER_BUILD}/Chromium.app/Contents/MacOS/Chromium"
	).expanduser()


def resolve_browser_executable(environ: Mapping[str, str] | None = None) -> Path:
	"""Engager's own Chromium, and no other (US-OND-04).

	Setup downloads the one pinned build to
	`~/.engager/browser/chromium-<build>/Chromium.app/Contents/MacOS/Chromium`;
	the sidecar runs exactly that file. `ENGAGER_BROWSER_EXECUTABLE` may
	name it (the launcher does), but a named path anywhere else -- another
	build, another directory, a resolved Chrome -- refuses with
	BROWSER_NOT_INSTALLED, as does a missing or unreadable pinned file:
	falling back to a resolved Chrome or a silent Playwright download is
	the surprise this replaces, so no uvx/playwright process is ever
	spawned from here.
	"""
	env = os.environ if environ is None else environ
	pinned = _pinned_browser_executable()
	named = env.get("ENGAGER_BROWSER_EXECUTABLE")
	if named and Path(named).expanduser().resolve() != pinned.resolve():
		raise SidecarError(
			"BROWSER_NOT_INSTALLED",
			"Engager's own browser is not installed; run Mac setup to download it",
		)
	if (
		not _has_chrome_segment(str(pinned))
		and pinned.is_file()
		and os.access(pinned, os.X_OK)
	):
		return pinned
	raise SidecarError(
		"BROWSER_NOT_INSTALLED",
		"Engager's own browser is not installed; run Mac setup to download it",
	)


def _isolated_development_browser() -> bool:
	"""Only the Dev artifact in its private home uses a test keychain.

	The server's environment is intentionally not forwarded to the sidecar.
	Use the same artifact identity as developmentBootstrap, never an ambient
	flag that could change a production browser's credential storage.
	"""
	if sys.platform != "darwin":
		return False
	home = Path(os.environ.get("HOME", "")).resolve()
	if home.name != "home" or home.parent.name != ".engager-dev":
		return False
	try:
		resources = Path(__file__).resolve().parents[4]
		info = plistlib.loads((resources.parent / "Info.plist").read_bytes())
		profile = json.loads((resources / "development-profile.json").read_text())
		return (
			isinstance(info, dict)
			and isinstance(profile, dict)
			and info.get("CFBundleIdentifier") == "com.engager.menubar.dev"
			and profile.get("bundleIdentifier") == "com.engager.menubar.dev"
			and profile.get("rootName") == ".engager-dev"
		)
	except (OSError, ValueError, IndexError):
		return False


LINKEDIN_ORIGIN = "https://www.linkedin.com"
FEED_URL = f"{LINKEDIN_ORIGIN}/feed/"
# LinkedIn's own sign-in page, which Open LinkedIn again navigates to: a signed-in
# browser is sent on to the feed from here, so asking is never a sign-out.
LOGIN_URL = f"{LINKEDIN_ORIGIN}/login"
# Both spellings LinkedIn serves, for the prefix test that decides whether a
# page is already where we want it — and therefore whether navigating would
# take it away from something the owner is in the middle of.
LINKEDIN_ORIGINS = ("https://www.linkedin.com/", "https://linkedin.com/")
CURSOR_TTL_SECONDS = 24 * 60 * 60
MAX_DISCOVERY_SCROLLS = 12
# profileUpdatesV2 page size. Verified live: one request returned 100 fully
# parsed posts, so a normal sweep needs a single call.
VOYAGER_PAGE_MAX = 100
# Bound on keyset pages per author, so a token that never stops advancing cannot
# turn one discovery call into an unbounded crawl of somebody's whole history.
VOYAGER_MAX_PAGES = 10
# Search hydration is one request PER post — batch is unavailable (?ids=List()
# 400s, urnOrNss=List() 500s). Bound the fan-out so one keyword cannot turn a
# single discovery call into a burst of reads.
SEARCH_HYDRATION_MAX = 25
# One search-index request returns one LinkedIn results page: ten results,
# measured live. Asking for ten and stepping `start` by ten is right whether or
# not a larger `count` would be honoured, so a page cannot skip results.
SEARCH_INDEX_PAGE = 10
# Index requests one discovery page may make to fill its hydration budget.
SEARCH_INDEX_REQUESTS_MAX = 4
# Keyword searches were refused (HTTP 413) in three bursts, each right after an
# agent start and its browser warm-up, and at no other time (agent.log,
# 2026-10-12 and 10-13). So a browser session's first index request waits until
# the browser has been up SEARCH_WARMUP_S and the page carries the csrf cookie
# the request is signed with, polled SEARCH_SESSION_CHECKS times; and a refused
# index request is asked once more after SEARCH_RETRY_PAUSE_S, once per
# discovery page. With the hydration budget, all of it stays inside the 60s the
# client gives one discover op (client.ts), whose timeout restarts the sidecar.
SEARCH_WARMUP_S = 10.0
SEARCH_SESSION_CHECKS = 10
SEARCH_SESSION_CHECK_S = 0.5
SEARCH_RETRY_PAUSE_S = 8.0
# LinkedIn's own values for the content search's date-posted filter.
DATE_POSTED_FILTER = {"past_day": "past-24h", "past_week": "past-week", "past_month": "past-month"}
# A pause before reading the NEXT page of a search the sweep is already in, the
# way a person reads one page and then scrolls on. The first page of a search
# takes none: the sweep's own pacing is between searches.
PAGE_TURN_DELAY_MIN_S = 2.0
PAGE_TURN_DELAY_SPAN_S = 3.0
# The WHOLE shutdown's budget, asking politely and forcing together.
#
# `client.ts`'s DEFAULT_IDLE_SHUTDOWN_MS must EXCEED it, and the comment there
# says so: that is the budget the node side gives this one before its reap
# signals a sidecar which is still closing a browser — the exact interruption
# this file exists to end. A deadline rather than three independent timeouts,
# because three of them add up and only a total can be pinned against anything.
BROWSER_SHUTDOWN_BUDGET_S = 25.0
# How long Chromium gets to honour `Browser.close` before it is forced. The
# wait is what makes the cookie flush observable (see `_close_local_browser`).
BROWSER_CLOSE_TIMEOUT_S = 10.0
# How long `Browser.close` itself is given to answer. It usually does not: the
# command tears the CDP socket down as it works, so the reply is lost and the
# process wait below is the evidence.
BROWSER_CLOSE_REQUEST_TIMEOUT_S = 2.0

# Where a hidden window is created and parked: beyond any display, and inside
# the ±16000 the macOS window server keeps a window's origin to. Never negative,
# because a launch position is never negative.
OFFSCREEN_ORIGIN = 15_000

# Bytes the DOM this sidecar reads never needs, and a residential proxy bills
# for: `media` and `dms` serve profile pictures, feed images and uploaded
# documents (`media-exp*` is the older CDN alias LinkedIn still emits), and the
# extensions are video containers and HLS playlists. Scripts and stylesheets
# live on static.licdn.com and are deliberately absent — blocking those does not
# save bandwidth, it breaks the page.
BLOCKED_MEDIA_URLS = (
	"*://media.licdn.com/*",
	"*://dms.licdn.com/*",
	"*://media-exp*.licdn.com/*",
	"*.mp4",
	"*.mp4?*",
	"*.webm",
	"*.webm?*",
	"*.m3u8",
	"*.m3u8?*",
)

_PROFILE_SLUG_RE = re.compile(r"/(?:in|company|school)/([A-Za-z0-9_%\-\.]+)")


def normalize_author_profile_id(value: Any) -> str:
	"""Canonical author identity: LinkedIn's bare public identifier.

	`profile_id` is a PRIMARY KEY in engaged_profiles, leads and author_profiles,
	and the partition key for per-person pacing in rate_limit_ledger. One person
	stored under two spellings gets double the rate-limit allowance and defeats
	the already-engaged check — a safety failure, not cosmetics.

	The canonical form is the bare slug, matching what Voyager returns (`publicIdentifier` for
	members, `universalName` for companies). Only the DOM path differed, having
	emitted a full profile URL.

	KNOWN, UNADDRESSED: `/in/<slug>` and `/company/<slug>` are separate LinkedIn
	namespaces, so a company could in principle collide with a member of the same
	slug. Discovery engages people only by default and `authorIsCompany` travels
	alongside, so this is recorded rather than solved.
	"""
	if not isinstance(value, str):
		return ""
	raw = value.strip()
	if not raw:
		return ""
	match = _PROFILE_SLUG_RE.search(raw)
	slug = match.group(1) if match else raw
	# LinkedIn slugs are case-insensitive; fold so one person is one key.
	return slug.rstrip("/").lower()


def member_address(value: str) -> str:
	"""The member a profile read asks for, as their address spells it: a public
	identifier folded as `normalize_author_profile_id` folds it, and the id in
	a profile urn — LinkedIn's own `/in/<id>/` — as minted, its case being the
	id's."""
	match = _PROFILE_SLUG_RE.search(value.strip())
	raw = (match.group(1) if match else value.strip()).rstrip("/")
	return raw if MEMBER_ID_RE.fullmatch(raw) else normalize_author_profile_id(value)


# A comment row, on the legacy post page (`data-id`) and on the 2026-10-08
# redesign (`componentkey="replaceableComment_<urn>"`): what the page's markup
# is read by where LinkedIn's comment data does not answer.
COMMENT_ITEM_SELECTOR = (
	':is(article.comments-comment-item, .comments-comment-item, '
	'.comments-comment-entity, [data-id*="urn:li:comment"], '
	'[componentkey^="replaceableComment_urn:li:comment:"])'
)
# Bounded wait for the comment list to hydrate before reconciliation reads it.
# 40 x 0.5s = 20s ceiling, paid in full only when a post really has no comments.
# The first cut here was 6s, which a live run disproved: a post with 20 comments
# took ~10s to render its first row, so a 6s budget would have read zero and
# reported "not posted" about a live comment. Keep well clear of the observed
# worst case rather than tuning it close.
COMMENT_HYDRATION_ATTEMPTS = 40
COMMENT_HYDRATION_DELAY_S = 0.5
# The receipt of a like whose POST answered nothing a 2xx settles: the post
# opened afresh at its action target and LinkedIn's data for it read (`like_data.py`,
# `comment_data.py`): first a moment after the POST's answer, for LinkedIn's
# data trails a write, then once more, at most.
LIKE_RECEIPT_READS = 2
LIKE_RECEIPT_DELAY_S = 3.0
# A comment's or a reply's one POST whose answer settles nothing: LinkedIn's
# comment data read back for it this many times, this far apart — each read can
# only find it — before it is left uncertain for the reconcile to read again.
WRITE_READ_BACKS = 2
WRITE_READ_BACK_DELAY_S = 2.0
# How far LinkedIn's clock may stand from this machine's: a comment read back
# for an attempt is its only when written no earlier than this before it.
READ_BACK_SKEW_MS = 120_000
# Reading the replies under our comment: pages of top-level comments loaded to
# find our row, then presses of a replies control under it, each followed by a
# fresh read. Every press is read-side. Sized under the transport's 60s budget
# with the hydration wait above in front of them.
REPLY_COMMENT_PAGES = 3
REPLY_EXPANSIONS = 6
REPLY_EXPANSION_DELAY_S = 1.0
# Binding a press on a profile page: fresh reads of its markup until the top
# card its data names renders. Nothing is pressed between them.
PROFILE_HYDRATION_ATTEMPTS = 20
PROFILE_HYDRATION_DELAY_S = 0.5
# Reading the inbox: how long after the compose view is opened its own load
# may take to receive the conversation list. Nothing is requested meanwhile.
# The experience page fills in after it opens; this long between looks, this many.
ROLE_SETTLE_S = 2.5
ROLE_POLLS = 4
INBOX_CAPTURE_WAIT_S = 15.0
# Putting back the unread mark of a conversation a thread read opened. The
# press of a card that moves the page off it, and the restore, each wait 3–7s
# first: each is a conversation loaded on the account, spaced as the conversation
# spaces its thread reads (`conversations/inbox.ts` READ_JITTER). After the press,
# reads of the page until the list marks that card active on a thread's
# address, twice running: 12 x 0.25s bounds it at 3s. The restore opens the
# card's menu, looks for its "Mark as unread" up to 8 x 0.25s, and re-reads the
# card up to 8 x 0.25s for its unread mark: about 21s at every bound, inside
# the transport's 60s with the thread's own wait.
CARD_PRESS_JITTER_MIN_S = 3.0
CARD_PRESS_JITTER_SPAN_S = 4.0
CARD_OPEN_ATTEMPTS = 12
CARD_OPEN_DELAY_S = 0.25
CARD_MENU_ATTEMPTS = 8
UNREAD_CONFIRM_ATTEMPTS = 8
CARD_MENU_DELAY_S = 0.25
THREAD_HYDRATION_ATTEMPTS = 20
THREAD_HYDRATION_DELAY_S = 0.5
# Accepting an invitation: fresh reads until the request's row renders, its
# Accept bound in it. Nothing is pressed between them.
ACCEPT_ROW_ATTEMPTS = 20
ACCEPT_ROW_DELAY_S = 0.5
# After pressing Accept: reads of the same page until the request's Accept is
# gone, so the navigation that confirms it cannot cut the request off. The
# relationship read that follows decides, whatever these show.
ACCEPT_SETTLE_ATTEMPTS = 10
ACCEPT_SETTLE_DELAY_S = 0.5
# A receipt that is a read of the member's profile — an Accept's, a
# withdrawal's, and the read a confirmed invitation carries — waits
# PROFILE_RECEIPT_DELAY_S for the profile to catch up with the write, reads
# it, and does so again when the read does not show the write, for the
# profile page trails the write: on 2026-10-15
# every Accept's first read showed no `1st`, and invitations went unconfirmed
# too; only the first reconcile look, 78-126s after the click, settled them.
# At most PROFILE_RECEIPT_READS reads; nothing is pressed between them, and a
# read that shows the write ends it at once.
# CEILING: a commit that outlasts the transport (PROFILE_RECEIPT_COMMIT_TIMEOUT_MS,
# 80s, driver.ts) tears the sidecar down with the attempt CLICKING, which the
# core settles as `commit_unanswered`. Three slow reads would take longer, so no
# read BEGINS later than PROFILE_RECEIPT_BUDGET_S after the press; one begun
# runs its page load to the end, and an Accept's invitations page follows the
# last. Do not raise these without raising the transport timeout with them.
PROFILE_RECEIPT_READS = 3
PROFILE_RECEIPT_DELAY_S = 6.0
PROFILE_RECEIPT_BUDGET_S = 30.0
# A read after the first that fails for want of a page leaves the last clean
# read the answer: the profile that would not load this time, and the browser
# or navigation that failed under it. A wall is never among them.
PROFILE_RECEIPT_RETRY_CODES = frozenset({"PROFILE_UNAVAILABLE", "BROWSER_TRANSIENT", "NAVIGATION_FAILED"})
# A write's page: how long its own client is given to have sent the API
# request that names the page (`_page_identity`) — the profile's sends one
# within a couple of seconds of its document, long before a write is made.
PAGE_IDENTITY_POLLS = 20
PAGE_IDENTITY_POLL_S = 0.25
# How long a post's page, once opened, still stands for the comment sent from
# it and the like that rides it: the reconcile read before the send, the send
# and the like are one visit of a person's, and a page left longer than this
# is opened again. A bound well inside the account's lease for a send
# (`EXECUTION_LEASE_MS`).
POST_VISIT_REUSE_S = 120.0
# Withdrawing an invitation: after the top card's More is pressed, fresh reads
# until its menu renders the keyed Pending; after the Pending is pressed,
# until LinkedIn's confirmation opens; after its Withdraw, until it closes or
# LinkedIn prints a refusal. Each sits inside the transport's 60s beside a
# profile read.
WITHDRAW_MENU_ATTEMPTS = 6
WITHDRAW_MENU_DELAY_S = 0.5
WITHDRAW_CONFIRMATION_ATTEMPTS = 10
WITHDRAW_CONFIRMATION_DELAY_S = 0.5
WITHDRAW_SETTLE_ATTEMPTS = 10
WITHDRAW_SETTLE_DELAY_S = 0.5
# What a history read fails with where the conversation's page may still be
# read: an answer it does not know, or a conversation list it does not
# recognise.
HISTORY_FALLBACK_CODES = frozenset({"HISTORY_UNAVAILABLE", "UI_DRIFT"})
# A first message's compose view: how long its load may take to name the
# member, and how much longer the rest of what names them may take to finish.
COMPOSE_CONTEXT_WAIT_S = 12.0
COMPOSE_CONTEXT_GRACE_S = 3.0
# Reading the notification cards: how long after the feed is opened its own
# load may take to receive them. Nothing is requested meanwhile; a load that
# received none by then has the first page fetched once.
NOTIFICATION_CAPTURE_WAIT_S = 15.0
# Keeping a page's document: how long after the page is interactive its body
# may take to finish arriving, and how much of one the browser keeps — a post's
# document carries its comments' data, a profile's its top card's, and each
# runs to megabytes.
DOCUMENT_CAPTURE_WAIT_S = 10.0
DOCUMENT_BUFFER_BYTES = 64 * 1024 * 1024
# What `_goto` waits after the navigation: up to GOTO_READY_POLLS polls
# GOTO_READY_POLL_S apart for a document that is `interactive`, then a flat
# GOTO_SETTLE_S. Every page load pays it, beside the wait for its document.
GOTO_READY_POLLS = 30
GOTO_READY_POLL_S = 0.1
GOTO_SETTLE_S = 0.6
# Each further page of the account's own comments (`own_comments.py`) is the
# response to the request LinkedIn's own pager makes when the activity page's
# scroller is taken to its end: a flight of 11-13 MB that took seconds to finish
# arriving. A window that is hidden or covered does not run the pager's
# observer unless the page is made to think it is focused
# (Emulation.setFocusEmulationEnabled, on for the read and off after it;
# captured 2026-10-29). The scroll is made once and given
# OWN_COMMENTS_SCROLL_WAIT_S to make the pager begin to answer; if it still does
# not, the request the document declared is made from the page instead, once and
# for good in that read (`_own_comments_scroll`). A pager that has begun to
# answer is waited for to OWN_COMMENTS_PAGE_WAIT_S in all, and the page's own
# request is given OWN_COMMENTS_FETCH_TIMEOUT_MS, all within the read's
# OWN_COMMENTS_PAGING_BUDGET_S.
OWN_COMMENTS_SCROLL_WAIT_S = 8.0
OWN_COMMENTS_PAGE_WAIT_S = 30.0
OWN_COMMENTS_FETCH_TIMEOUT_MS = 20_000
# The pages of one read share this deadline from the first page asked for; past
# it the read returns what it has. The client's transport outlasts it
# (`OWN_COMMENTS_TIMEOUT_MS` in driver.ts).
OWN_COMMENTS_PAGING_BUDGET_S = 100.0
# The most one page may come to: a page is ~13 MB, and a response past this is
# refused, never read.
OWN_COMMENT_PAGE_BYTES = 32 * 1024 * 1024
OWN_COMMENTS_PAGER_RE = re.compile(
	r"/flagship-web/rsc-action/actions/pagination\?(?:[^#]*&)?sduiid=com\.linkedin\.sdui\.pagers\.profile\.ActivityDetail(?:&|#|$)"
)
# The activity page's window does not scroll; its scroller is <main>. Taking it
# to the end is what a person reaching the end of the list does, and the only
# thing this does — nothing is pressed or typed.
SCROLL_ACTIVITY_LIST_JS = r"""() => {
  const scroller = document.querySelector('main');
  if (!scroller) return JSON.stringify({scrolled: false});
  scroller.scrollTop = scroller.scrollHeight;
  return JSON.stringify({scrolled: true});
}"""
# The pager's request as the page makes it (captured 2026-10-29): a POST of the
# declared body, JSON, in the page's session, with the headers the page's own
# client named itself by beside the CSRF token from the session cookie. An
# answer that never comes is status 0 with what stopped it. Never retried.
OWN_COMMENTS_PAGE_JS = r"""(path, body, pageHeaders, timeoutMs, maxBytes) => (async () => {
  const jsession = (document.cookie.match(/JSESSIONID="?([^";]+)"?/) || [])[1] || '';
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      signal: abort.signal,
      headers: {
        ...JSON.parse(pageHeaders),
        'csrf-token': jsession,
        'x-li-rsc-stream': 'true',
        'content-type': 'application/json',
      },
      body,
    });
    const tooLarge = () => { abort.abort(); return JSON.stringify({frame: 'page', status: res.status, tooLarge: true}); };
    if (Number(res.headers.get('content-length') || 0) > maxBytes) return tooLarge();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parts = [];
    let size = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) return tooLarge();
      parts.push(decoder.decode(value, {stream: true}));
    }
    parts.push(decoder.decode());
    return JSON.stringify({frame: 'page', status: res.status, body: parts.join('')});
  } catch (e) {
    return JSON.stringify({frame: 'page', status: 0, error: String(e)});
  } finally {
    clearTimeout(timer);
  }
})()"""
# The document a member's profile is served as, at whatever `/in/` address a
# redirect lands it on — `/in/me/` resolves to the account's own.
PROFILE_DOCUMENT_ADDRESS = re.compile(r"^https://(?:www\.)?linkedin\.com/in/[^/?#]+/?(?:[?#]|$)")
# The document a conversation's own page is served as.
CONVERSATION_DOCUMENT_ADDRESS = re.compile(r"^https://(?:www\.)?linkedin\.com/messaging/thread/[^/?#]+/?(?:[?#]|$)")
OWN_PROFILE_URL = f"{LINKEDIN_ORIGIN}/in/me/"
COMMENT_COUNT_JS = r"""(selector) => JSON.stringify(document.querySelectorAll(selector).length)"""

# Read-side expansion only: pages a long comment list so the action target row can
# render, for reconciliation. No write control is ever selected here.
LOAD_MORE_COMMENTS_JS = r"""() => {
  const buttons = [...document.querySelectorAll('button')];
  const button = buttons.find(item => /load more comments|show more comments|more comments/i.test(item.innerText || item.getAttribute('aria-label') || ''));
  if (!button) return false;
  button.click();
  return true;
}"""


class BrowserBackend(Protocol):
	async def connected_account_id(self, *, preserve_page: bool = False) -> str: ...

	async def warm_browser(self) -> dict[str, Any]: ...

	async def ensure_session(self) -> dict[str, Any]: ...

	async def discover_posts(self, params: dict[str, Any]) -> dict[str, Any]: ...

	async def fetch_own_profile(self) -> dict[str, str] | None: ...

	async def fetch_own_posts(self, limit: int) -> list[dict[str, Any]]: ...

	async def fetch_own_comments(self, limit: int) -> OwnCommentsRead: ...

	async def prepare_comment(self, input_value: dict[str, Any]) -> dict[str, Any]: ...

	async def validate_prepared_comment(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> None: ...

	async def commit_prepared_comment(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> str: ...

	async def prepare_reply(self, input_value: dict[str, Any]) -> dict[str, Any]: ...

	async def prepare_room_reply(self, input_value: dict[str, Any]) -> dict[str, Any]: ...

	async def validate_prepared_room_reply(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> None: ...

	async def commit_prepared_room_reply(self, input_value: dict[str, Any], expected_account_id: str, prepared: dict[str, Any]) -> str: ...

	async def reconcile_room_reply(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> str | None: ...

	async def validate_prepared_reply(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> None: ...

	async def commit_prepared_reply(
		self,
		input_value: dict[str, Any],
		expected_account_id: str,
		prepared: dict[str, Any],
	) -> str: ...

	async def reconcile_posted(self, input_value: dict[str, Any], since_ms: int | None = None) -> str | None: ...

	async def reconcile_reply(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> str | None: ...

	async def like_post(self, post_urn: str) -> str: ...

	async def read_post_thread(self, post_urn: str, max_comments: int, order: str = "RELEVANCE", start: int = 0) -> dict[str, Any]: ...

	async def read_author_profile(self, profile_id: str, role: bool = False) -> dict[str, Any]: ...

	async def read_company_page(self, company_ref: str) -> dict[str, Any]: ...

	async def read_comment_replies(
		self,
		post_urn: str,
		comment_urn: str,
		since_ms: int | None,
		limit: int,
		vouched_reply_urns: frozenset[str] = frozenset(),
		room_reply_urn: str | None = None,
	) -> dict[str, Any]: ...

	async def read_notifications(self, start: int) -> dict[str, Any]: ...

	async def read_relationship(
		self, profile_id: str | None, profile_url: str | None, place: bool = False
	) -> dict[str, Any]: ...

	async def read_incoming_invitations(self, since_ms: int | None, limit: int) -> dict[str, Any]: ...

	async def prepare_acceptance(self, input_value: dict[str, Any], tag: str) -> dict[str, Any]: ...

	async def validate_prepared_acceptance(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> None: ...

	async def commit_prepared_acceptance(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> dict[str, Any]: ...

	async def acceptance_read_back(self, input_value: dict[str, Any], *, pages: int = 2) -> dict[str, Any]: ...

	async def read_inbox(self, since_ms: int | None, limit: int) -> dict[str, Any]: ...

	async def read_dm_thread(
		self, thread_id: str, since_ms: int | None, *, restore_unread: bool = False
	) -> dict[str, Any]: ...

	async def read_conversation_messages(
		self, thread_id: str, limit: int, members: Mapping[str, str] | None = None
	) -> dict[str, Any]: ...

	async def read_page_for_agent(self, target: AgentReadTarget) -> dict[str, Any]: ...

	async def prepare_invitation(self, input_value: dict[str, Any], expected: dict[str, str]) -> dict[str, Any]: ...

	async def validate_prepared_invitation(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> None: ...

	async def commit_prepared_invitation(
		self, input_value: dict[str, Any], prepared: dict[str, Any]
	) -> dict[str, Any]: ...

	async def prepare_withdrawal(self, input_value: dict[str, Any], tag: str) -> dict[str, Any]: ...

	async def validate_prepared_withdrawal(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> None: ...

	async def commit_prepared_withdrawal(
		self, input_value: dict[str, Any], prepared: dict[str, Any]
	) -> dict[str, Any]: ...

	async def prepare_dm(self, input_value: dict[str, Any], expected: dict[str, str], origin: str) -> dict[str, Any]: ...

	async def validate_prepared_dm(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> None: ...

	async def commit_prepared_dm(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> dict[str, Any]: ...

	async def dm_read_back(
		self, thread_id: str, members: Mapping[str, str] | None, *, limit: int
	) -> tuple[dict[str, Any], bool]: ...

	async def prepare_open_dm(self, input_value: dict[str, Any], origin: str) -> dict[str, Any]: ...

	async def commit_prepared_open_dm(
		self, input_value: dict[str, Any], prepared: dict[str, Any], since_ms: int
	) -> dict[str, Any]: ...

	async def open_dm_read_back(
		self, recipient: str, profile_urn: str, since_ms: int
	) -> tuple[dict[str, Any] | None, bool]: ...

	async def like_comment(self, post_urn: str, comment_urn: str, parent_comment_urn: str | None = None) -> str: ...

	async def read_like_state(
		self, post_urn: str, comment_urn: str | None, parent_comment_urn: str | None = None
	) -> dict[str, Any]: ...

	async def rehide_if_needed(self) -> None: ...

	def signing_in(self) -> bool: ...

	async def set_window_visibility(
		self, window: str | None, *, reveal: bool = False, place: Mapping[str, int] | None = None
	) -> dict[str, Any]: ...

	async def restart_browser(self, *, place: Mapping[str, int] | None = None) -> dict[str, Any]: ...

	async def shutdown(self) -> None: ...


POSTS_JS = r"""() => {
  const first = (root, selectors) => {
    for (const selector of selectors) {
      const value = root.querySelector(selector);
      if (value) return value;
    }
    return null;
  };
  const clean = value => (value || '').replace(/\s+/g, ' ').trim();
  const activity = value => {
    if (!value) return null;
    // A malformed percent-sequence must not abort the whole extraction.
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch (_) { decoded = value; }
    const direct = decoded.match(/urn:li:(?:activity|ugcPost|share):[A-Za-z0-9_-]+/);
    if (direct) return direct[0];
    // Permalink slug form: /posts/<slug>-<type>-<id>-<hash>/ carries the same
    // identity without the literal `urn:li:` prefix.
    const slug = decoded.match(/\/posts\/[A-Za-z0-9_%-]+?-(ugcPost|activity|share)-(\d+)-[A-Za-z0-9_-]+/);
    return slug ? `urn:li:${slug[1]}:${slug[2]}` : null;
  };
  /** LinkedIn renders each actor string twice — one visible copy marked
   *  aria-hidden, one .visually-hidden copy for screen readers. Reading
   *  innerText concatenates both ("Slava Nikitin Slava Nikitin • You ...").
   *  Prefer the visible copy; otherwise drop the screen-reader duplicates. */
  const visibleText = node => {
    if (!node) return '';
    const shown = node.querySelector(':scope > span[aria-hidden="true"]')
      || node.querySelector('span[aria-hidden="true"]');
    if (shown) return clean(shown.innerText);
    const clone = node.cloneNode(true);
    for (const hidden of clone.querySelectorAll('.visually-hidden, [aria-hidden="true"]')) {
      hidden.remove();
    }
    return clean(clone.innerText);
  };
  /** LinkedIn activity ids are snowflake-style: the publication time in ms sits
   *  in the high bits (id >> 22). This is EXACT, needs no extra request, and is
   *  independent of markup — so it is the primary timestamp source.
   *  BigInt is required: these ids exceed Number.MAX_SAFE_INTEGER and a plain
   *  Number conversion silently loses precision. */
  const urnTimestamp = urn => {
    const match = /urn:li:(?:activity|ugcPost|share):(\d+)/.exec(urn || '');
    if (!match) return NaN;
    try {
      const ms = Number(BigInt(match[1]) >> 22n);
      // Sanity-bound it: anything outside LinkedIn's plausible lifetime means
      // the id was not snowflake-encoded and must not be trusted.
      if (ms < 1104537600000 || ms > Date.now() + 86400000) return NaN;
      return ms;
    } catch (_) {
      return NaN;
    }
  };
  /** Fallback only. The actor sub-description carries a bucketed relative age
   *  ("3w • 3 weeks ago • ..."), so two posts weeks apart can collapse to the
   *  same value. Used only when the urn yields nothing. */
  const relativeAge = text => {
    const match = clean(text).match(/^(\d+)\s*(mo|yr|[smhdwy])\b/i);
    if (!match) return NaN;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return NaN;
    const unit = match[2].toLowerCase();
    const spans = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
      mo: 30 * 24 * 60 * 60 * 1000,
      y: 365 * 24 * 60 * 60 * 1000,
      yr: 365 * 24 * 60 * 60 * 1000,
    };
    const span = spans[unit];
    return span ? Date.now() - amount * span : NaN;
  };
  const candidates = [
    ...document.querySelectorAll('[data-urn*="urn:li:activity"], [data-urn*="urn:li:ugcPost"], div.feed-shared-update-v2, li.reusable-search__result-container')
  ];
  const rows = [];
  const seen = new Set();
  for (const card of candidates) {
    const postLink = first(card, [
      'a[href*="/feed/update/urn:li:"]',
      'a[href*="/posts/"]',
      'a[href*="/pulse/"]'
    ]);
    const dataUrnNode = card.closest('[data-urn]') || card.querySelector('[data-urn]') || card;
    const postUrn = activity(dataUrnNode.getAttribute && dataUrnNode.getAttribute('data-urn')) || activity(postLink && postLink.href) || activity(card.outerHTML);
    if (!postUrn || seen.has(postUrn)) continue;
    const content = first(card, [
      '.update-components-text',
      '.feed-shared-update-v2__description',
      '.feed-shared-inline-show-more-text',
      '[data-test-id="main-feed-activity-card__commentary"]'
    ]);
    const authorLink = first(card, [
      'a.update-components-actor__meta-link',
      'a.feed-shared-actor__container-link',
      'a[href*="/in/"]',
      'a[href*="/company/"]'
    ]);
    const authorNameNode = first(card, [
      '.update-components-actor__title',
      '.update-components-actor__name',
      '.feed-shared-actor__name',
      '[data-test-id="main-feed-activity-card__actor-name"]'
    ]);
    const headlineNode = first(card, ['.update-components-actor__description', '.feed-shared-actor__description']);
    const timeNode = first(card, ['time[datetime]']);
    const datetime = timeNode && timeNode.getAttribute('datetime');
    // Timestamp precedence, most exact first:
    //  1. the snowflake-encoded time inside the post urn (exact, markup-free)
    //  2. <time datetime> if LinkedIn still renders one
    //  3. the bucketed relative age in the actor sub-description
    let parsedTime = urnTimestamp(postUrn);
    if (!Number.isFinite(parsedTime) && datetime) {
      parsedTime = Date.parse(datetime);
    }
    if (!Number.isFinite(parsedTime)) {
      const ageNode = first(card, [
        '.update-components-actor__sub-description',
        '.feed-shared-actor__sub-description'
      ]);
      parsedTime = relativeAge(ageNode && visibleText(ageNode));
    }
    const postUrl = postLink && postLink.href ? postLink.href.split('?')[0] : `https://www.linkedin.com/feed/update/${postUrn}/`;
    // External assets: the share card's article link + outbound anchors in the
    // post body. Captured RAW (queries intact — redirect wrappers keep their
    // target); the server filters linkedin.com chrome and normalizes.
    const articleCard = first(card, [
      '.update-components-article',
      '.feed-shared-article',
      '.update-components-mini-article'
    ]);
    const articleLink = articleCard ? articleCard.querySelector('a[href^="http"]') : null;
    const articleTitleNode = articleCard ? first(articleCard, [
      '.update-components-article__title',
      '.feed-shared-article__title',
      '.update-components-article__meta'
    ]) : null;
    const bodyLinks = content
      ? [...content.querySelectorAll('a[href^="http"]')].map((a) => a.href).slice(0, 5)
      : [];
    const media = (articleLink && articleLink.href) || bodyLinks.length
      ? Object.assign(
          {},
          articleLink && articleLink.href
            ? { article: { url: articleLink.href, title: visibleText(articleTitleNode) || null } }
            : {},
          bodyLinks.length ? { links: bodyLinks } : {}
        )
      : null;
    seen.add(postUrn);
    rows.push({
      postUrn,
      authorProfileId: authorLink && authorLink.href ? authorLink.href.split('?')[0] : null,
      authorName: visibleText(authorNameNode) || visibleText(authorLink),
      authorHeadline: visibleText(headlineNode),
      authorIsCompany: Boolean(authorLink && /\/company\//.test(authorLink.href)),
      url: postUrl,
      contentText: clean(content && content.innerText),
      postedAt: Number.isFinite(parsedTime) ? parsedTime : null,
      detectedLanguage: null,
      authorGeo: null,
      media: media,
      metrics: null
    });
  }
  return JSON.stringify(rows);
}"""


SESSION_JS = r"""() => {
  const url = location.href;
  const body = (document.body && document.body.innerText || '').slice(0, 12000).toLowerCase();
  // WHAT THIS PAGE IS, from the address bar and the login form: true of the
  // page itself, whoever wrote the text on it.
  //
  // ROOT-ANCHORED, because the pathname is not ours either. LinkedIn serves
  // every wall from the root — /login, /authwall, /uas/login, /checkpoint/...,
  // /challenge/... — while an author source lands on /in/<slug>/recent-activity/
  // all/, and a slug is whatever that person called themselves. Unanchored,
  // `challenger-sales` or `checkpoint-systems` read as the owner's own account
  // being challenged: CHECKPOINT_REQUIRED, a fifteen-minute park, and on a
  // hosted channel an e-mail — for discovering an ordinary consultancy.
  const login = /^\/(?:login|authwall|uas)(?:\/|$)/.test(location.pathname) || Boolean(document.querySelector('form.login__form, #username, input[name="session_key"]'));
  const checkpointPath = /^\/(?:checkpoint|challenge)(?:\/|$)/.test(location.pathname);
  // WHAT THIS PAGE SAYS. Reliable on the feed, where every word belongs to
  // LinkedIn; a lie on a search results page, where the words are other
  // people's posts and a post about identity verification or account
  // restrictions would report the owner's own account challenged. Reported
  // separately so a caller that navigated somewhere can decline to read them.
  const checkpointBody = body.includes('security verification') || body.includes('verify your identity');
  const restricted = body.includes('your account has been restricted') || body.includes('temporarily restricted');
  return JSON.stringify({url, login, checkpointPath, checkpoint: checkpointPath || checkpointBody, restricted});
}"""


COMMENTS_JS = r"""(ownProfileUrl, wantedText, expectedPostUrn) => {
  const clean = value => (value || '').replace(/\s+/g, ' ').trim();
  // A long comment renders with an inline expander whose label lands INSIDE
  // innerText: "...Which ones are you counting? …more". The full body is still
  // there; only the affordance is extra. Byte-exact equality therefore failed
  // for every comment past LinkedIn's truncation threshold, so a real posted
  // comment could never be recognised and settled UNCERTAIN — observed live on
  // a 377-char comment that rendered as 383 chars (suffix " …more"), while a
  // 209-char one confirmed fine. Stripped on BOTH sides, so a comment that
  // genuinely ends in "…more" still compares equal.
  const stripMore = value => value.replace(/\s*(?:…|\.\.\.)\s*(?:see\s+)?more$/i, '').trim();
  // The post a comment belongs to, read out of the comment urn's inner reference.
  // On a comment LIST page (recent-activity/comments) there is no expectedPostUrn
  // and no /feed/update/ link anywhere in the node, and the nearest [data-urn]
  // ancestor is a per-comment WRAPPER activity that is never the post — measured
  // live: three own comments carried wrappers ...7592602521600 / ...0422574080000
  // / ...0937927307264 while their real posts were ugcPost:7488629221834186752
  // and activity:7488637099810840576. The inner reference IS the post, in
  // whichever form LinkedIn minted it (see postUrn.ts for canonicalisation).
  const postFromCommentUrn = value => {
    if (!value) return null;
    const match = value.match(/urn:li:comment:\((?:urn:li:)?((?:activity|ugcPost|share):[A-Za-z0-9_-]+),/);
    return match ? `urn:li:${match[1]}` : null;
  };
  const canonical = value => {
    try {
      const url = new URL(value, location.origin);
      return `${url.origin}${url.pathname}`.replace(/\/$/, '');
    } catch (_) { return ''; }
  };
  const activity = value => {
    if (!value) return null;
    // A malformed percent-sequence must not abort the whole extraction.
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch (_) { decoded = value; }
    const match = decoded.match(/urn:li:(?:activity|ugcPost|share):[A-Za-z0-9_-]+/);
    return match ? match[0] : null;
  };
  const commentUrn = value => {
    if (!value) return null;
    // A malformed percent-sequence must not abort the whole extraction.
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch (_) { decoded = value; }
    // LinkedIn writes the inner post reference WITHOUT its own `urn:li:` prefix:
    //   urn:li:comment:(ugcPost:7480615507541417984,7489547410856394753)
    // Requiring the prefix matched nothing, so every posted comment came back
    // with commentUrn=null and reconciliation could never confirm its own write.
    const match = decoded.match(/urn:li:comment:\((?:urn:li:)?(?:activity|ugcPost|share):[A-Za-z0-9_-]+,[A-Za-z0-9_-]+\)|urn:li:comment:[A-Za-z0-9_-]+/);
    return match ? match[0] : null;
  };
  const nodes = [...document.querySelectorAll('[data-id*="urn:li:comment"], article.comments-comment-item, .comments-comment-item, .comments-comment-entity, [componentkey^="replaceableComment_urn:li:comment:"]')];
  const out = [];
  const seen = new Set();
  for (const node of nodes) {
    // The redesign renders the body in its expandable text box; the meta lines
    // above it (name, headline, time) are separate paragraphs.
    const textNode = node.querySelector('.comments-comment-item__main-content, .comments-comment-item-content-body, .comments-comment-item__inline-show-more-text, .update-components-text, [data-testid="expandable-text-box"]');
    const text = stripMore(clean(textNode && textNode.innerText));
    if (!text) continue;
    // Every semantic actor-link class above is gone — the comment meta now
    // carries hashed classes (vwtlHyztdgx...). The href is the durable signal,
    // so fall back to any profile link inside this comment. Without it `own` is
    // always false and reconciliation cannot recognise our own comment.
    const author = node.querySelector('a.comments-post-meta__actor-link[href*="/in/"], .comments-post-meta__profile-info-wrapper a[href*="/in/"], a.comments-comment-item__actor-link[href*="/in/"], .comments-post-meta__name a[href*="/in/"]')
      || node.querySelector('a[href*="/in/"]');
    const authorUrl = canonical(author && author.href);
    const own = Boolean(ownProfileUrl && authorUrl && authorUrl === canonical(ownProfileUrl));
    // The row's own key first: in the redesign it IS the comment urn, and a
    // nested reply's markup must never win the first match.
    const source = (node.getAttribute('data-id') || '') + ' ' + (node.getAttribute('componentkey') || '') + ' ' + node.outerHTML;
    const urn = commentUrn(source);
    const postLink = node.closest('[data-urn]') || node.querySelector('a[href*="/feed/update/urn:li:"]');
    // Attribution order matters. A comment urn is often keyed to the ugcPost form
    // of its post while callers address it by the activity urn, and those ids are
    // independently allocated — so deriving the post from the comment urn can
    // yield a spelling that never compares equal, which is why the permalink case
    // must win. When this page IS the expected post's permalink, attribute to that
    // post and nothing else; that check alone is what makes reconciliation work.
    // Only when there is no expected post (a comment LIST page) fall through to
    // the comment urn's inner reference, which is at least genuinely this post in
    // one of its two spellings, rather than the wrapper activity that ranked
    // first before and is never the post at all.
    let pageUrl = location.href;
    try { pageUrl = decodeURIComponent(location.href); } catch (_) {}
    const onExpectedPost = Boolean(expectedPostUrn) && pageUrl.split('?')[0].includes(expectedPostUrn);
    const postUrn = onExpectedPost
      ? expectedPostUrn
      : postFromCommentUrn(urn)
        || activity((postLink && postLink.getAttribute && postLink.getAttribute('data-urn')) || (postLink && postLink.href) || node.closest('main')?.outerHTML || '');
    const key = urn || `${postUrn || ''}:${authorUrl}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!wantedText || (own && text === stripMore(clean(wantedText)))) {
      out.push({commentUrn: urn, postUrn, text, own, authorUrl});
    }
  }
  return JSON.stringify(out);
}"""


def _known_member(person: dict[str, Any], members: Mapping[str, str]) -> dict[str, Any]:
	"""A participant the list names by member urn alone, named by the profile
	`members` knows for that urn where it knows one."""
	known = members.get(person.get("memberUrn") or "")
	if person["profileId"] is not None or not known:
		return person
	return {**person, "profileId": known, "profileUrl": f"{LINKEDIN_ORIGIN}/in/{known}/"}


class BrowserUseBackend:
	"""One persistent, headed Chromium session serialized by the sidecar."""

	def __init__(self) -> None:
		self._browser: Chromium | None = None
		self._page: Page | None = None
		self._probe_context: str | None = None
		self._own_profile_url: str | None = None
		self._own_display_name: str | None = None
		# The headline of the same mini profile. Held for the sign-in step's
		# "Is this you?" and nothing else: nothing stores it.
		self._own_headline: str | None = None
		self._own_public_identifier: str | None = None
		# The account's profile urn and member number, beside its public
		# identifier: a profile page's data names a member by both, and these
		# say which member is the account itself.
		self._own_profile_urn: str | None = None
		self._own_member_id: str | None = None
		# Whether the last own-posts sweep ran out of pages before its limit.
		self.author_posts_cut_short = False
		self._profile_dir = Path(os.environ.get("ENGAGER_BROWSER_PROFILE_DIR", "~/.engager/browser-profile")).expanduser()
		self._cdp_url = os.environ.get("ENGAGER_BROWSER_CDP_URL") or None
		self._headless = os.environ.get("ENGAGER_BROWSER_HEADLESS", "false").lower() == "true"
		# Headed but hidden: the launched Chrome keeps its full headed
		# fingerprint but is hidden from the screen (macOS app hide), so an
		# unattended run never steals focus. Only an interactive probe — the
		# owner pressing Test connection to sign in — brings it back to the
		# front. Never applies to a CDP attach: that is a browser we do not own.
		# The owner's choice on Settings › This Mac replaces this default at
		# every launch (`_hidden_by_choice`).
		self._hidden_by_default = os.environ.get("ENGAGER_BROWSER_HIDDEN", "true").lower() != "false"
		self._hidden = self._hidden_by_default
		# Whether the last attempt to hide the window found no mechanism that
		# worked: the window is on the owner's screen against their choice.
		self._hide_failed = False
		# Whether the window is up for a sign-in the owner has not finished.
		self._sign_in_window = False
		# Refuse page media at the network layer.  OFF unless asked: a CDP
		# attach is not evidence of the cloud browser — the same variable
		# attaches to a Chrome the owner launched (README), where bytes are free
		# and they may be looking at the window.  The bridge turns this on for
		# the HOSTED placement, which is the one that knows (hostedBrowserChildEnv).
		self._block_media = os.environ.get("ENGAGER_BROWSER_BLOCK_MEDIA", "false").lower() == "true"
		self._browser_pid: int | None = None
		# Whether the last `_close_local_browser` ended on Chromium's own
		# shutdown rather than on a forced stop. Only the first flushes the
		# cookie store, so `self_check` reads it before it trusts a cookie.
		self._closed_gracefully = False
		# Whether we believe the window is on screen. Chrome used to die between
		# jobs, so a sign-in probe's unhide could never outlive the job that
		# asked for it; with one persistent Chrome, the window a probe surfaced
		# would otherwise stay up forever. `rehide_if_needed` reads this before
		# every non-interactive op.
		self._visible = False
		# The window sits off every display: created there by a hidden launch,
		# or parked there by the CDP fallback (osascript denied).
		self._offscreen = False
		# Where the window was on screen before it was parked, to put it back;
		# None puts it where a launch would have, the top-left.
		self._saved_origin: tuple[int, int] | None = None
		# This browser's signed-in session, minted each time it starts: a read
		# stamped with it was made in the session that stamp names, and a
		# restart — the nightly recycle included — is a different one.
		self._session_id: str | None = None
		# When that session's browser started, and the session whose first
		# search-index request has been made: the first waits out the warm-up
		# (`_await_search_session`).
		self._started_at: float | None = None
		self._search_session: str | None = None
		# The address the page's own client last fetched the notification cards
		# from, kept from any request it makes while the tap listens: a later
		# page of them is the same request at another offset.
		self._notification_cards_url: str | None = None
		# The network events a page load's own JSON is kept from (`_capture_json`).
		self._network_tap = NetworkTap()
		# What the compose view's load of the conversation list said, for a
		# history read in the same page (`read_conversation_messages`): the
		# account's mailbox, every listed conversation as the list read it, and
		# the headers the page's own request carried.
		self._mailbox: str | None = None
		self._listed: dict[str, dict[str, Any]] = {}
		self._page_headers: dict[str, str] = {}
		# Whether this read of the own comments still lets the pager make the
		# request for its next page (`_next_own_comments_page`).
		self._own_comments_scroll = True
		self._own_comments_tab_lost = False
		self._own_comments_deadline = float("inf")
		# The history query ids — the newest the page's own client was seen to
		# use, from any request it makes while the tap listens.
		self._messages_queries = {"latest": LATEST_MESSAGES_QUERY, "older": OLDER_MESSAGES_QUERY}
		self._network_tap.learn = self._learn_page_request
		# The page the standing tab last opened for a write's sake, and the
		# headers the open page's own client names it by (`_on_page`).
		self._visit: PageVisit | None = None
		self._page_identity_seen = PageIdentity()
		self._rsc_headers_seen = RscPageHeaders()

		def observe(event: Any) -> None:
			self._page_identity_seen.on_request(event)
			self._rsc_headers_seen.on_request(event)

		self._network_tap.observe = observe
		# The `activity:<id>` each post's comments are keyed by (`_post_comment_pages`).
		self._thread_refs: dict[str, str] = {}
		# The order LinkedIn last answered a post's comments in, asked first.
		self._comment_order: str | None = None

	async def _start(self) -> None:
		if self._browser is not None:
			return
		try:
			installed = importlib.metadata.version("cdp-use")
		except importlib.metadata.PackageNotFoundError as exc:
			raise SidecarError("DEPENDENCY_MISSING", f"cdp-use {CDP_USE_VERSION} is not installed") from exc
		if installed != CDP_USE_VERSION:
			raise SidecarError(
				"DEPENDENCY_VERSION_MISMATCH",
				f"expected cdp-use {CDP_USE_VERSION}, found {installed}",
			)
		try:
			from .chromium import Chromium, launch_args

			if self._cdp_url:
				self._browser = await Chromium.attach(self._cdp_url)
				self._offscreen = False
			else:
				await self._reap_orphaned_browser()
				# Engager's own pinned Chromium, never a resolved Chrome
				# (US-OND-04): a missing install refuses here, before any
				# process exists, so nothing resolves or downloads one itself.
				executable = resolve_browser_executable()
				# A hidden app's windows are "backgrounded" to Chromium's
				# scheduler, which would throttle timers and rendering mid-run.
				# Harmless when the window is visible.
				extra = [
					"--disable-backgrounding-occluded-windows",
					"--disable-renderer-backgrounding",
					"--disable-background-timer-throttling",
					# `--disable-blink-features=AutomationControlled` is among the
					# default flags, and stays so navigator.webdriver stays
					# false. Chromium answers it with an unsupported-command-line-flag
					# infobar; test-type removes it, and the missing-Google-API-keys
					# infobar too. LinkedIn needs none of those Google services.
					"--test-type",
				]
				if _isolated_development_browser():
					# The private HOME has no owner login keychain. Keep test
					# cookies in that profile without opening macOS reset dialogs.
					extra.append("--use-mock-keychain")
				self._hidden = self._hidden_by_choice()
				# Created off every display when hidden, so no frame of it reaches
				# the screen before the hide below lands: the flash at launch was
				# the window Chrome opens at the top-left until then.
				position = (OFFSCREEN_ORIGIN, OFFSCREEN_ORIGIN) if self._hidden else None
				self._browser = await Chromium.launch(
					executable,
					launch_args(self._profile_dir, extra, headless=self._headless, window_position=position),
				)
				self._browser_pid = self._browser.pid
				self._offscreen = position is not None
			self._session_id = uuid.uuid4().hex
			self._started_at = time.monotonic()
			self._page = await self._browser.page_for_work()
			self._probe_context = await self._page_context(self._page)
			await self._block_media_on(self._page)
			self._visible = True
			self._saved_origin = None
			# The off-screen launch is the first layer; the app-hide or the
			# park is the second, and says so where neither works.
			if self._hidden:
				await self._hide_window()
		except SidecarError:
			if self._browser is not None:
				await (self._browser.detach() if self._cdp_url else self._browser.kill())
				self._browser = None
				self._page = None
				self._browser_pid = None
			raise
		except Exception as exc:
			if self._browser is not None:
				await (self._browser.detach() if self._cdp_url else self._browser.kill())
			self._browser = None
			self._page = None
			self._browser_pid = None
			raise SidecarError("BROWSER_UNAVAILABLE", f"could not start the browser: {exc}", retryable=True) from exc

	async def _block_media_on(self, page: Page) -> None:
		"""Refuse BLOCKED_MEDIA_URLS on one page, best-effort.

		`Network.setBlockedURLs` is scoped to a CDP session, and a session is
		scoped to a CDP target, so every page this sidecar opens has to ask again.
		The page names its own target rather than leaving it to the browser's
		current focus: the identity probe's page would otherwise block media on
		the feed instead.

		Best-effort like `_hide_window`: a failure is one stderr line. A page
		that still loads images costs bandwidth; it is not broken. That line
		surfaces only for a local sidecar — the hosted arm discards sidecar
		stderr, which may carry the CDP credential across chunks — so a cloud
		refusal shows up as bandwidth on the provider dashboard, not as a log.
		"""
		if not self._block_media or self._browser is None:
			return
		try:
			session = await self._browser.session_for(page.target_id)
			await session.cdp_client.send.Network.enable(session_id=session.session_id)
			await session.cdp_client.send.Network.setBlockedURLs(
				params={"urls": list(BLOCKED_MEDIA_URLS)},
				session_id=session.session_id,
			)
		except Exception as exc:  # noqa: BLE001 — blocking is never load-bearing
			print(f"[browser-use] could not block media: {exc}", file=sys.stderr, flush=True)

	def _run_osascript(self, lines: list[str]) -> None:
		argv = ["osascript"]
		for line in lines:
			argv += ["-e", line]
		subprocess.run(argv, check=True, capture_output=True, timeout=10)

	async def _set_app_visible(self, visible: bool, *, front: bool = False) -> bool:
		"""Hide or surface the launched Chrome app on macOS, best-effort.

		Uses System Events app-hide — the same symmetric mechanism both ways —
		so denying the one-time Automation permission simply leaves the window
		visible; `_hide_window` then falls back to parking it off-screen via
		CDP. A CDP attach is a browser we do not own and is never touched.
		`front` also brings it in front of the owner's own app, which only an
		owner's press may ask for. Returns whether the osascript actually ran.
		"""
		if sys.platform != "darwin" or self._cdp_url:
			return False
		pid = self._browser_pid
		if pid is None:
			print("[browser-use] could not resolve browser pid; window stays visible", file=sys.stderr, flush=True)
			return False
		process = f'(first process whose unix id is {pid})'
		lines = [f'tell application "System Events" to set visible of {process} to {"true" if visible else "false"}']
		if visible and front:
			lines.append(f'tell application "System Events" to set frontmost of {process} to true')
		try:
			await asyncio.to_thread(self._run_osascript, lines)
			return True
		except Exception as exc:  # noqa: BLE001 — hiding is never load-bearing
			print(f"[browser-use] could not change window visibility: {exc}", file=sys.stderr, flush=True)
			return False

	async def _window_cdp(self) -> tuple[Any, int] | None:
		"""The root CDP client and the browser window id, or None."""
		client = getattr(self._browser, "cdp_client", None)
		if client is None:
			return None
		try:
			target = await client.send_raw("Browser.getWindowForTarget", {})
			window_id = target.get("windowId")
			if window_id is None:
				return None
			# Only a window on the screen says where the owner wants it back;
			# one off it is where a hide put it.
			if not self._offscreen:
				bounds = target.get("bounds") or {}
				left, top = bounds.get("left"), bounds.get("top")
				self._saved_origin = (
					int(left) if isinstance(left, (int, float)) else 0,
					int(top) if isinstance(top, (int, float)) else 0,
				)
			return client, int(window_id)
		except Exception as exc:  # noqa: BLE001 — hiding is never load-bearing
			print(f"[browser-use] window lookup failed: {exc}", file=sys.stderr, flush=True)
			return None

	async def _park_offscreen(self) -> bool:
		"""Move the window off every display via CDP — no Automation permission
		needed. The window still exists (full headed fingerprint, Mission
		Control can find it); it just never occupies the screen."""
		found = await self._window_cdp()
		if found is None:
			return False
		client, window_id = found
		try:
			await client.send_raw(
				"Browser.setWindowBounds",
				{"windowId": window_id, "bounds": {"left": OFFSCREEN_ORIGIN, "top": OFFSCREEN_ORIGIN}},
			)
			self._offscreen = True
			return True
		except Exception as exc:  # noqa: BLE001
			print(f"[browser-use] off-screen park failed: {exc}", file=sys.stderr, flush=True)
			return False

	async def _restore_onscreen(self, place: Mapping[str, int] | None = None) -> None:
		"""Put the window back on a display: where it was before it was parked, or
		— where the caller names an area (`place`: left, top, width, height) — in
		that area, on screen already or not."""
		if not self._offscreen and place is None:
			return
		found = await self._window_cdp()
		if found is None:
			return
		client, window_id = found
		left, top = self._saved_origin or (0, 0)
		bounds: dict[str, Any] = {"left": left, "top": top}
		if place is not None:
			# `normal` as well: a minimised window takes no bounds.
			bounds = {**place, "windowState": "normal"}
		try:
			await client.send_raw("Browser.setWindowBounds", {"windowId": window_id, "bounds": bounds})
			self._offscreen = False
		except Exception as exc:  # noqa: BLE001
			print(f"[browser-use] on-screen restore failed: {exc}", file=sys.stderr, flush=True)

	async def _hide_window(self) -> None:
		"""Take the window off the owner's screen, one of two ways: the app-hide
		when Automation is permitted, else the CDP off-screen park."""
		if sys.platform != "darwin" or self._cdp_url:
			return
		hidden = await self._set_app_visible(False) or await self._park_offscreen()
		self._visible = not hidden
		self._hide_failed = not hidden
		# Not silently: the settings and channel pages read this and tell the
		# owner which permission the hide is missing.
		record_hide(self._profile_dir.parent, failed=not hidden)
		if not hidden:
			print("[browser-use] window stays visible (no hide mechanism worked)", file=sys.stderr, flush=True)

	async def _show_window(self, *, front: bool = True, place: Mapping[str, int] | None = None) -> None:
		"""Surface the window, reversing whichever mechanism hid it. In front of
		the owner's own app only when `front`: a press of theirs asked to see it.
		`place` is the area to put it in, beside whatever else the owner is using."""
		if self._cdp_url:
			return
		await self._restore_onscreen(place)
		await self._set_app_visible(True, front=front)
		self._visible = True

	async def rehide_if_needed(self) -> None:
		"""Re-hide after an interactive probe surfaced the window — the next
		unattended op is proof the owner's sign-in moment is over, unless they
		are still signing in (`signing_in`): on an install with campaigns
		running, a five-minute job arrives while they are typing. Chrome used
		to die between jobs, which is why this never existed before."""
		if self._browser is None or not self._hidden or not self._visible or self.signing_in():
			return
		await self._hide_window()

	def signing_in(self) -> bool:
		"""Whether the owner is at the window signing in: a look of theirs found
		LinkedIn's sign-in page or a check, none has found them signed in since,
		and the last was recent (`SIGN_IN_LEASE_S`)."""
		return self._sign_in_window and self._browser is not None and self._browser.signing_in()

	def _hidden_by_choice(self) -> bool:
		"""Whether the window is kept off the screen: the owner's choice on
		Settings › This Mac where one is saved, else the launch default."""
		choice = read_choice(self._profile_dir.parent)
		return self._hidden_by_default if choice is None else choice == "hidden"

	async def set_window_visibility(
		self, window: str | None, *, reveal: bool = False, place: Mapping[str, int] | None = None
	) -> dict[str, Any]:
		"""Apply the owner's choice of window at once (`window`), or bring the
		window up for this session (`reveal`: Show Engager's browser), which the
		next unattended task hides again while the choice is Hidden.

		Only the window moves: no page is opened or navigated, and the session
		and whatever task holds the page are left as they are. A choice made
		while no browser runs starts none; the next launch reads it from the
		file the dashboard saved it in. Shown never comes in front of the
		owner's app; a reveal does, because the owner asked to look.
		"""
		if window is not None:
			self._hidden = window == "hidden"
			if self._browser is not None:
				if self._hidden:
					await self._hide_window()
				else:
					await self._show_window(front=False)
					if self._hide_failed:
						self._hide_failed = False
						record_hide(self._profile_dir.parent, failed=False)
		elif reveal:
			await self._start()
			await self._show_window(front=True, place=place)
		return {
			"window": "hidden" if self._hidden else "shown",
			"onScreen": self._browser is not None and self._visible,
			"hideFailed": self._hide_failed,
		}

	async def _evaluate_json_on(self, page: Any, script: str, *args: Any) -> Any:
		try:
			raw = await page.evaluate(script, *args)
			return json.loads(raw)
		except (json.JSONDecodeError, TypeError) as exc:
			raise SidecarError("DOM_CHANGED", "page extraction returned an invalid shape") from exc
		except SidecarError:
			raise
		except Exception as exc:
			raise SidecarError("BROWSER_TRANSIENT", f"browser evaluation failed: {exc}", retryable=True) from exc

	async def _evaluate_json(self, script: str, *args: Any) -> Any:
		await self._start()
		assert self._page is not None
		return await self._evaluate_json_on(self._page, script, *args)

	async def _goto(self, url: str) -> None:
		parsed = urlparse(url)
		if parsed.scheme != "https" or parsed.hostname not in {"linkedin.com", "www.linkedin.com"}:
			raise SidecarError("NAVIGATION_BLOCKED", "only https://www.linkedin.com navigation is allowed")
		await self._start()
		assert self._page is not None
		self._visit = None
		try:
			await self._page.goto(url)
			for _ in range(GOTO_READY_POLLS):
				state = await self._page.evaluate("() => document.readyState")
				if state in {"interactive", "complete"}:
					break
				await asyncio.sleep(GOTO_READY_POLL_S)
			await asyncio.sleep(GOTO_SETTLE_S)
		except Exception as exc:
			raise SidecarError("NAVIGATION_FAILED", f"LinkedIn navigation failed: {exc}", retryable=True) from exc

	async def _session_snapshot(self) -> dict[str, Any]:
		return await self._evaluate_json(SESSION_JS)

	@staticmethod
	async def _page_url(page: Any) -> str | None:
		"""A page's URL, or None when it can no longer answer. The owner closing
		a tab leaves a CDP target id that RAISES on the next read rather than a page
		reporting a blank URL, and a probe is not the place to discover that as
		a stack trace."""
		if page is None:
			return None
		try:
			return await page.get_url()
		except Exception:  # noqa: BLE001 — a closed tab is not a probe failure
			return None

	@staticmethod
	async def _page_context(page: Any) -> str | None:
		"""The browser context a page belongs to, or None when it cannot be
		read. `get_pages()` lists targets by TYPE and not by context, so under a
		CDP attach it returns the incognito and foreign-profile tabs of the
		whole browser alongside ours."""
		if page is None:
			return None
		try:
			info = await page.get_target_info()
		except Exception:  # noqa: BLE001 — an unreadable target is simply unknown
			return None
		return info.get("browserContextId") if isinstance(info, dict) else None

	async def _adopt_linkedin_page(self, *, context: str | None = None) -> bool:
		"""Adopt a tab already on the LinkedIn origin, in the browser context we
		are already working in.

		A sign-in happens in whichever tab LinkedIn opened it in: the checkpoint
		lands in one, the e-mailed confirmation link in another, and the page
		this sidecar happened to be holding is not the one the owner is typing
		into. Reading only that page and navigating it to the feed is what
		bounced a sign-in that was completing next door (observed 2026-09-14).

		A candidate is taken only when its context MATCHES the one we hold; a
		held context we cannot read leaves the listing unfiltered, which is the
		one-context case a local profile always is.
		"""
		if self._browser is None:
			return False
		try:
			pages = await self._browser.get_pages()
		except Exception:  # noqa: BLE001 — a context we cannot list is one page
			return False
		context = context if context is not None else await self._page_context(self._page)
		for candidate in pages:
			url = await self._page_url(candidate)
			if url is None or not url.startswith(LINKEDIN_ORIGINS):
				continue
			if context is not None and await self._page_context(candidate) != context:
				continue
			self._page = candidate
			return True
		return False

	async def _prepare_probe_page(self, interactive: bool) -> bool:
		"""Whether the page this sidecar now holds is already on LinkedIn.

		An INTERACTIVE probe additionally adopts a tab already on the origin,
		because the owner may be signing in on one. An unattended run keeps the
		page it was given: its own navigation is what the caller drives, and
		swapping that page under it would move an operation to a tab nobody
		asked for. Either way a page that can no longer answer is replaced, so
		a closed tab costs a fresh one rather than a raw CDP error.
		"""
		held = await self._page_url(self._page)
		if held is not None:
			self._probe_context = await self._page_context(self._page)
		if held is not None and held.startswith(LINKEDIN_ORIGINS):
			return True
		# The replacement is opened BEFORE the listing is considered, because
		# the context filter reads the page we hold: a dead one reports no
		# context at all, and the unfiltered listing it falls back to is the
		# whole attached browser — incognito and foreign profiles included.
		if held is None and self._browser is not None:
			await self._replace_probe_page()
			self._probe_context = await self._page_context(self._page)
		if interactive and await self._adopt_linkedin_page():
			return True
		return False

	async def _prepare_watched_page(self) -> bool:
		"""`_prepare_probe_page` for a probe that only WATCHES a sign-in: the page
		held, or a tab already on LinkedIn, and never a new one. A window the
		owner closed stays closed until they ask for it again."""
		held = await self._page_url(self._page)
		if held is not None:
			self._probe_context = await self._page_context(self._page)
		if held is not None and held.startswith(LINKEDIN_ORIGINS):
			return True
		# A closed target cannot identify its context. Only a match against
		# the context retained while it was alive can replace it during a watch.
		if self._probe_context is None:
			return False
		return await self._adopt_linkedin_page(context=self._probe_context)

	async def _replace_probe_page(self) -> None:
		"""A page where the one held cannot answer: a new tab in the browser if it
		still runs, else — the owner quit it, and its process went with the
		connection — the next browser. Without that, a browser quit once would
		wedge every probe behind a handle to nothing until the sidecar restarted."""
		assert self._browser is not None
		try:
			self._page = await self._browser.new_page()
		except Exception as exc:  # noqa: BLE001 — a connection that is gone raises whatever it raises
			print(f"[browser-use] the browser is gone ({exc}); starting another", file=sys.stderr, flush=True)
			self._browser = None
			self._page = None
			self._browser_pid = None
			await self._start()
			return
		await self._block_media_on(self._page)

	async def warm_browser(self) -> dict[str, Any]:
		"""Start the standing holder without navigating or probing LinkedIn."""
		await self._start()
		return {"ok": True}

	async def ensure_session(
		self,
		interactive: bool = False,
		*,
		surface: bool | None = None,
		sign_in: bool = False,
		place: Mapping[str, int] | None = None,
	) -> dict[str, Any]:
		"""The probe. `interactive` means the owner is at the window (Test
		connection, the sign-in step): a tab already on LinkedIn is adopted, and
		who is signed in is read again, because the owner may have signed in as
		someone else since the last look. `surface` — by default whenever the probe
		is interactive — also brings the window up, in front, and `place` says
		where; a probe that is only WATCHING a sign-in (interactive, not surfacing)
		leaves the window wherever the owner put it, and opens nothing if they
		closed it. `sign_in` goes to LinkedIn's own sign-in page first."""
		surfacing = interactive and (interactive if surface is None else surface)
		watching = interactive and not surfacing
		if watching and self._browser is None:
			# Nothing runs to watch, and a watch is no reason to start a browser.
			return {"ok": False, "reason": "browser_closed"}
		await self._start()
		assert self._page is not None
		launched = self._session_id
		# An interactive probe means the owner pressed Test connection and may
		# be about to sign in — surface the window whatever state the session
		# turns out to be in. Unattended callers never unhide.
		if surfacing:
			await self._show_window(place=place)
		# Navigate only when nothing we hold is on LinkedIn yet: a blank
		# profile's first probe still needs the feed to put the login page in
		# front of the owner, but a probe that arrives while they are signing in
		# must read what is there rather than replace it. A repeated probe
		# inside a sign-in wait is then exactly one in-page snapshot.
		on_linkedin = await (self._prepare_watched_page() if watching else self._prepare_probe_page(interactive))
		if surfacing and self._session_id != launched:
			# The browser the owner quit was replaced by this one, which starts
			# the way every launch does — hidden, if that is their choice.
			await self._show_window(place=place)
		if watching and await self._page_url(self._page) is None:
			return {"ok": False, "reason": "browser_closed"}
		assert self._browser is not None
		# The owner at the window may sign in with Google or Apple, whose pages
		# the tab guard sends back at any other time.
		if interactive:
			self._browser.owner_signing_in(True)
		if sign_in:
			await self._goto(LOGIN_URL)
		elif not on_linkedin:
			# LinkedIn's sign-in page can hand its own tab to the provider. The
			# feed now would take that page from under the owner mid-sign-in.
			if self._browser.signing_in_on(await self._page_url(self._page)):
				return {"ok": False, "reason": "login_required"}
			await self._goto(FEED_URL)
		try:
			snapshot = await self._session_snapshot()
		except SidecarError as exc:
			if exc.code != "DOM_CHANGED":
				raise
			# The page answered in a shape the wall test cannot read: LinkedIn
			# changed, which is not a sign-in the owner can finish.
			raise SidecarError("UI_DRIFT", "LinkedIn's page could not be read for the sign-in check") from exc
		reason = self._wall_reason(snapshot)
		if reason:
			refused: dict[str, Any] = {"ok": False, "reason": reason}
			# `login_required` is two answers: LinkedIn's own sign-in page, and a
			# page that could not be placed on LinkedIn at all, which a network
			# that is down produces as well. Only the first says the account is
			# signed out, so it is the one that is named.
			if reason == "login_required" and snapshot.get("login") and str(snapshot.get("url", "")).startswith(LINKEDIN_ORIGINS):
				refused["signInPage"] = True
			self._sign_in_window = self._sign_in_window or interactive
			return refused
		self._browser.owner_signing_in(False)
		if self._sign_in_window:
			# The sign-in this window was up for has just been seen done. The
			# next unattended task hides it as well, and can be minutes away,
			# with the owner looking at a window that has nothing left to ask.
			self._sign_in_window = False
			await self.rehide_if_needed()
		# The session is live. Learn WHOSE it is once per sidecar lifetime so the
		# product can confirm "Connected as <name>" instead of an anonymous tick —
		# and again on every interactive probe, which is how a sign-out and a
		# sign-in as someone else in this same browser are noticed.
		# One XHR against the page already loaded here — no navigation, and the
		# congruence guard in _voyager_get refuses unless the browser is already
		# on the LinkedIn origin, which the checks above just proved. Strictly
		# best-effort: a failure must never turn a good session into a bad one.
		# The public identifier comes from the SAME probe: it is the durable half
		# of the identity — a display name is not one, because a rename on the
		# network would silently rewrite whose account this is.
		if interactive or not self._own_display_name or not self._own_public_identifier:
			try:
				if not self._learn_own(await self._voyager_get("/voyager/api/me", route_prefix=LINKEDIN_ORIGIN)):
					self._forget_reported_identity(interactive)
			except VoyagerUnavailable as exc:
				print(f"[voyager] session identity unavailable: {exc}", file=sys.stderr, flush=True)
				self._forget_reported_identity(interactive)
			except Exception as exc:  # noqa: BLE001 — identity is never load-bearing
				print(f"[voyager] session identity probe failed: {exc}", file=sys.stderr, flush=True)
				self._forget_reported_identity(interactive)
		result: dict[str, Any] = {"ok": True}
		account: dict[str, str] = {}
		if self._own_display_name:
			account["displayName"] = self._own_display_name
		if self._own_headline:
			account["headline"] = self._own_headline
		if self._own_public_identifier:
			account["externalAccountId"] = self._own_public_identifier
		if account:
			result["account"] = account
		return result

	def _forget_reported_identity(self, interactive: bool) -> None:
		"""An owner at the window asked who is signed in NOW; an answer that could
		not be read must not become the one from before, which may be someone else.
		The next probe of any kind learns it again."""
		if not interactive:
			return
		self._own_public_identifier = self._own_display_name = self._own_headline = None

	@staticmethod
	def _wall_reason(snapshot: dict[str, Any], *, body_signals: bool = True) -> str | None:
		"""Which wall this page is — in the probe's own vocabulary — or None when
		it is an ordinary signed-in LinkedIn page.

		ONE classifier, so every page the sidecar lands on is read the same way.
		A login wall and a challenge are different answers to the owner: one says
		sign in, the other says go clear something LinkedIn is asking for.

		`body_signals` is what the CALLER knows about the page. On the feed the
		words on the page are LinkedIn's own, so "security verification" means
		the account is being challenged. On a search results page the words are
		other people's posts, and a post about identity verification, KYC or
		account restrictions would otherwise report the owner challenged —
		`rate_limited=True`, a fifteen-minute park, and on a hosted channel an
		e-mail — for reading exactly the conversations it was pointed at. The
		address bar and the login form cannot be written by a stranger, so those
		two stay in scope wherever the sidecar has landed.
		"""
		if snapshot.get("checkpointPath") or (body_signals and snapshot.get("checkpoint")):
			return "checkpoint_required"
		if body_signals and snapshot.get("restricted"):
			return "account_restricted"
		if snapshot.get("login") or not str(snapshot.get("url", "")).startswith(LINKEDIN_ORIGINS):
			return "login_required"
		return None

	@staticmethod
	def _wall_error(reason: str) -> SidecarError:
		if reason == "checkpoint_required":
			return SidecarError("CHECKPOINT_REQUIRED", reason, rate_limited=True)
		if reason == "account_restricted":
			return SidecarError("ACCOUNT_RESTRICTED", reason, rate_limited=True)
		return SidecarError("LOGIN_REQUIRED", reason)

	async def _assert_ready(self) -> None:
		status = await self.ensure_session()
		if status["ok"]:
			return
		raise self._wall_error(str(status.get("reason", "session_not_ready")))

	async def _assert_landed_ready(self) -> None:
		"""Re-run the probe's wall test on the page we have just NAVIGATED to.

		`_assert_ready` proves the session was live on the page the sidecar was
		holding; it cannot prove the destination is. A signed-out search lands on
		`/login` or `/authwall`, whose markup has no posts in it — and the
		scraper's honest answer to a page with no posts is an empty list. That
		empty list reached the pool as `discovered: 0` and the sweep recorded
		itself `done` (observed 2026-09-15 on a blank free install: five keywords
		and three hashtags, six seconds, zero posts, no error anywhere). A wall
		is not an empty result, so it is raised as the refusal it is.
		"""
		reason = self._wall_reason(await self._session_snapshot(), body_signals=False)
		if reason:
			raise self._wall_error(reason)

	async def fetch_own_profile(self) -> dict[str, str] | None:
		await self._assert_ready()
		# /voyager/api/me answers in one XHR. LinkedIn's profile page renders no
		# h1, nor any heading bound to the member, so where /me does not answer
		# the account is read from its own profile's data instead.
		try:
			me = await self._voyager_get("/voyager/api/me", route_prefix=LINKEDIN_ORIGIN)
			if self._learn_own(me):
				name = own_display_name(me)
				return {"displayName": name} if name else None
			print("[identity] fell back to the own profile's data: /me named no account", file=sys.stderr, flush=True)
		except VoyagerUnavailable as exc:
			print(f"[identity] fell back to the own profile's data: {exc}", file=sys.stderr, flush=True)
		own = await self._own_from_profile_data(self._page, lambda: self._goto(OWN_PROFILE_URL))
		return {"displayName": own.display_name} if own.display_name else None

	async def connected_account_id(self, *, preserve_page: bool = False) -> str:
		"""Resolve the canonical connected profile URL, optionally without moving the prepared page."""
		if not preserve_page:
			await self.fetch_own_profile()
			if self._own_profile_url is None:
				raise SidecarError(
					"ACCOUNT_IDENTITY_UNAVAILABLE", "could not resolve the connected LinkedIn account", retryable=True
				)
			return self._own_profile_url

		await self._assert_ready()
		# Voyager first: one XHR, no navigation, so the prepared page is untouched
		# and there is no redirect to race. Congruent by construction — this is
		# the identity of the session already loaded in this browser, not content
		# from a page we never visited.
		try:
			if self._learn_own(await self._voyager_get("/voyager/api/me", route_prefix=LINKEDIN_ORIGIN)):
				assert self._own_profile_url is not None
				return self._own_profile_url
			print("[identity] fell back to the own profile's data: /me named no account", file=sys.stderr, flush=True)
		except VoyagerUnavailable as exc:
			print(f"[identity] fell back to the own profile's data: {exc}", file=sys.stderr, flush=True)

		assert self._browser is not None
		# Blank first: `new_page(url)` starts the navigation before anything can
		# be blocked on it, and a profile page is mostly pictures.
		probe = await self._browser.new_page()
		try:
			await self._block_media_on(probe)
			await self._own_from_profile_data(probe, lambda: self._load_own_profile(probe))
			assert self._own_profile_url is not None
			return self._own_profile_url
		finally:
			await self._browser.close_page(probe)

	def _learn_own(self, me: dict[str, Any]) -> bool:
		"""Keep who the account is, as `/voyager/api/me` names it: its public
		identifier — the durable half of the identity, which a rename on the
		network never rewrites — its name, its profile urn and its member
		number. False, and nothing kept, where /me names no public
		identifier."""
		identifier = own_public_identifier(me)
		if not identifier:
			return False
		self._keep_own_ids(identifier, urn_id=own_member_id(me), member_id=own_numeric_member_id(me))
		self._own_public_identifier = identifier
		self._own_profile_url = f"{LINKEDIN_ORIGIN}/in/{identifier}"
		if name := own_display_name(me):
			self._own_display_name = name
		self._own_headline = own_headline(me)
		return True

	def _keep_own_ids(self, identifier: str, *, urn_id: str | None, member_id: str | None) -> None:
		"""Keep the account's profile urn id and member number, which an
		answer need not carry every time: one that names neither leaves what an
		earlier answer for the same account taught, and one for another
		account (another public identifier) starts over, so no account's ids
		are ever taken for the next one's — nor its name or headline."""
		if (self._own_public_identifier or "").casefold() != identifier.casefold():
			self._own_profile_urn = self._own_member_id = None
			self._own_display_name = self._own_headline = None
		if urn_id:
			self._own_profile_urn = f"{PROFILE_URN_PREFIX}{urn_id}"
		if member_id:
			self._own_member_id = member_id

	async def _own_from_profile_data(self, page: Any, navigate: Callable[[], Awaitable[None]]) -> OwnProfile:
		"""The account from its own profile's data, where /me does not answer:
		`/in/me/` loaded on `page` by `navigate`, the document it is served as
		kept, and the account read off the data that says the page is the
		viewer's own and binds a public identifier to it (`profile_data.py`).
		ACCOUNT_IDENTITY_UNAVAILABLE where it does not tell: no write commits on
		an account nothing named."""
		document = await self._keep_document(page, PROFILE_DOCUMENT_ADDRESS, navigate, "the own profile's")
		try:
			if document is None:
				raise Unrecognised("the document was not kept")
			own = own_profile(profile_data(document_values(document)))
		except Unrecognised as exc:
			raise SidecarError(
				"ACCOUNT_IDENTITY_UNAVAILABLE", f"could not resolve the connected LinkedIn account: {exc}", retryable=True
			) from exc
		self._keep_own_ids(own.public_identifier, urn_id=own.urn_id, member_id=own.member_id)
		self._own_public_identifier = own.public_identifier
		self._own_profile_url = f"{LINKEDIN_ORIGIN}/in/{own.public_identifier}"
		if own.display_name:
			self._own_display_name = own.display_name
		return own

	@staticmethod
	async def _load_own_profile(probe: Any) -> None:
		"""Open `/in/me/` on a page of its own, through its redirect to the
		account's `/in/<slug>/`: readyState alone can report "complete" on the
		document before the redirect, so the resolved address is waited for
		too."""
		await probe.goto(OWN_PROFILE_URL)
		for _ in range(60):
			state = await probe.evaluate("() => document.readyState")
			current = str(await probe.get_url()).split("?")[0].rstrip("/")
			if state in {"interactive", "complete"} and "/in/" in current and not current.endswith("/in/me"):
				break
			await asyncio.sleep(0.1)

	async def _voyager_get(self, path: str, *, route_prefix: str) -> dict[str, Any]:
		"""Read LinkedIn's own JSON from the page that is ALREADY loaded, in its
		session.

		The call is refused unless the browser is currently on `route_prefix`;
		the prefix is the caller's, and so is the congruence it buys. The
		discovery, post and profile reads and the notification cards navigate
		first and pass that page's route, so they fetch only what it would have
		shown. The account's own identity (`/voyager/api/me`) and the reply
		read's comment data (`_comment_data_replies`) pass the LinkedIn origin
		alone, by design: from whatever LinkedIn page is open they ask for the
		account's own data — the replies to one of its own comments — a request
		no page the browser loaded made itself.

		Raises VoyagerUnavailable (never a SidecarError) so callers fall back to
		the DOM instead of failing the request.
		"""
		await self._start()
		assert self._page is not None
		current = await self._page.get_url()
		if not str(current).startswith(route_prefix):
			raise VoyagerUnavailable(
				f"route drift: on {current!r}, expected {route_prefix!r}"
			)
		if not path.startswith("/voyager/api/"):
			raise VoyagerUnavailable(f"refusing non-Voyager path {path!r}")
		try:
			raw = await self._page.evaluate(VOYAGER_FETCH_JS, path)
		except Exception as exc:
			raise VoyagerUnavailable(f"fetch failed: {exc}", transient=True) from exc
		try:
			envelope = json.loads(raw)
		except (TypeError, json.JSONDecodeError) as exc:
			raise VoyagerUnavailable(f"non-JSON envelope: {exc}") from exc
		if not envelope.get("ok"):
			status = envelope.get("status")
			raise VoyagerUnavailable(
				f"status={status} {str(envelope.get('error'))[:120]}",
				gone=status in (403, 404, 410),
				status=status if isinstance(status, int) else None,
				transient=isinstance(status, int) and (status in (0, 408, 429) or status >= 500),
			)
		content_type = str(envelope.get("contentType") or "")
		if "vnd.linkedin.normalized+json" not in content_type:
			# An HTML interstitial or a non-normalized shape means every path in
			# this reader is wrong; the DOM is the only honest answer.
			raise VoyagerUnavailable(f"unexpected content-type {content_type!r}")
		try:
			return json.loads(envelope["body"])
		except (KeyError, TypeError, json.JSONDecodeError) as exc:
			raise VoyagerUnavailable(f"unparseable body: {exc}") from exc

	async def _voyager_member_profile(self, slug: str, route: str) -> tuple[dict[str, Any], str]:
		"""A member's profile payload and the urn their activity is keyed by."""
		profile = await self._voyager_get(
			f"/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity={quote(slug, safe='')}",
			route_prefix=route,
		)
		match = re.search(r"urn:li:fsd_profile:[A-Za-z0-9_-]+", json.dumps(profile))
		if not match:
			raise VoyagerUnavailable("could not resolve the profile urn", gone=True)
		return profile, match.group(0)

	async def _voyager_author_posts(
		self,
		profile_path: str,
		limit: int,
		*,
		accept: Callable[[dict[str, Any], str], bool | None] | None = None,
	) -> list[dict[str, Any]]:
		"""Author posts from LinkedIn's JSON, fully hydrated — content, author,
		metrics — after a profile lookup to resolve the urn.

		`accept(row, profile_urn)` keeps only the rows it approves, and the sweep
		pages on until `limit` of them or the end of the feed: a feed of reposts
		is read past, not counted. It answers None for a row it cannot place;
		those are reported apart (`ACCOUNT_IDENTITY_UNAVAILABLE`) when nothing
		else was kept. A feed that ran out of pages before `limit` rows is left
		marked on `author_posts_cut_short`. Without `accept` every row counts,
		which is what discovering another author's posts wants.

		Pages with `paginationToken`, NOT `start`. Measured 2026-08-02: `start` is
		silently ignored, so `start=5&count=5` returned byte-identical posts to
		`start=0&count=5` and a caller could never get past the first window. The
		payload instead carries `data.metadata.paginationToken`, a keyset cursor
		that base64-decodes to "<last activity urn>-<epoch ms>". Feeding it back
		yielded three consecutive pages with ZERO overlap, each strictly older.

		`count` also scales further than the old caller assumed: one request
		returned 100 fully parsed posts, so the page size is a real lever and most
		sweeps need no second request at all.
		"""
		slug = profile_slug(profile_path)
		if not slug:
			raise VoyagerUnavailable(f"no /in/<slug> in {profile_path!r}")
		route = f"{LINKEDIN_ORIGIN}/in/{slug}"
		_, profile_urn = await self._voyager_member_profile(slug, route)

		wanted = max(1, int(limit))
		out: list[dict[str, Any]] = []
		seen: set[str] = set()
		token: str | None = None
		dropped = unplaced = 0
		recognised = False
		self.author_posts_cut_short = False
		for page in range(VOYAGER_MAX_PAGES):
			# A filtered sweep cannot know how many of a page it will keep, so it
			# asks for the whole window each time rather than the shrinking rest.
			wanted_now = wanted if accept else wanted - len(out)
			path = (
				"/voyager/api/identity/profileUpdatesV2?includeLongTermHistory=true"
				f"&count={max(1, min(wanted_now, VOYAGER_PAGE_MAX))}"
				f"&profileUrn={quote(profile_urn, safe='')}&q=memberShareFeed"
			)
			if token:
				path += f"&paginationToken={quote(token, safe='')}"
			updates = await self._voyager_get(path, route_prefix=route)
			rows = parse_updates(updates)
			elements = (updates.get("data") or {}).get("*elements") if isinstance(updates.get("data"), dict) else None
			recognised = recognised or bool(rows) or elements == []
			fresh = [r for r in rows if str(r.get("postUrn")) not in seen]
			if not fresh:
				break
			for row in fresh:
				seen.add(str(row.get("postUrn")))
				verdict = accept(row, profile_urn) if accept else True
				if not verdict:
					dropped += 1
					unplaced += verdict is None
					continue
				out.append(row)
				if len(out) >= wanted:
					break
			if len(out) >= wanted:
				break
			metadata = updates.get("data", {}).get("metadata") if isinstance(updates.get("data"), dict) else None
			nxt = metadata.get("paginationToken") if isinstance(metadata, dict) else None
			# A repeated token means the cursor has stopped moving; continuing
			# would re-request the same window until the page budget runs out.
			if not isinstance(nxt, str) or not nxt or nxt == token:
				break
			token = nxt
			self.author_posts_cut_short = page == VOYAGER_MAX_PAGES - 1

		if not out and not dropped and not (accept and recognised):
			raise VoyagerUnavailable("no posts resolved from the updates payload")
		if not out and unplaced:
			raise SidecarError(
				"ACCOUNT_IDENTITY_UNAVAILABLE",
				f"none of the {unplaced} posts could be placed as the connected account's: their authors did not resolve",
				retryable=True,
			)
		if dropped:
			print(f"[voyager] kept {len(out)} posts, set aside {dropped} not by the owner ({unplaced} unplaced)", file=sys.stderr, flush=True)
		if self.author_posts_cut_short:
			print(f"[voyager] stopped at {VOYAGER_MAX_PAGES} pages with {len(out)} of {wanted} posts", file=sys.stderr, flush=True)
		return [self._wire_post(row) for row in out][:wanted]

	async def _voyager_search_posts(
		self,
		term: str,
		limit: int,
		*,
		sort: str | None = None,
		date_posted: str | None = None,
		start: int = 0,
		already_seen: frozenset[str] = frozenset(),
	) -> tuple[list[dict[str, Any]], int, bool]:
		"""Keyword search posts: a urn index, then one hydration per urn.
		Answers the posts, the `start` the next page reads from, and whether
		the results ran out.

		`search/dash/clusters` is a PURE INDEX — measured live, 10 urns and zero
		resolvable posts in the payload — so unlike author discovery there is
		nothing to parse without a second call. Batch hydration is not available:
		`?ids=List(a,b)` answers 400 and `urnOrNss=List(a,b)` answers 500, both
		verified. Single `q=backendUrnOrNss` works, so hydration is per urn.

		Congruent: the caller is already ON this search results page, and the
		index is asked with the page's own sort and date filter, so these are
		the results that page displays. It used to ask with neither, and to
		re-read the first results every page: a search never reached past its
		first twenty-five. It pages with `start` now, one LinkedIn results page
		per request, and a batch the hydration budget cut short is read again
		next time, the seen set skipping what this one took. That the index
		honours `start` is not yet measured live; if it does not, the next
		offset answers the same results, and the search is marked exhausted on
		the spot instead of walking empty pages. HYDRATION_MAX bounds the
		fan-out so one keyword cannot turn into an unbounded read burst.

		A search LinkedIn refuses is UNAVAILABLE, raised as `SEARCH_UNAVAILABLE`
		and never an empty page: an empty page with no cursor is what parks a
		source as dry, and a refusal says nothing about the search. A refused
		index request is asked once more after a pause (`_search_index`); a
		refusal after earlier pages found posts keeps those and reads the
		refused page again next time. One refused as too large (413) both times,
		on its very first index request, is `SEARCH_TOO_LARGE` instead: that is a
		finding about the search — LinkedIn answers it to a query with more than
		three ORs, measured live — and the caller counts it against the search.
		A 413 after the search answered (an earlier page of this call, or a
		cursor past its first page) is not the query being too large, so it is
		`SEARCH_UNAVAILABLE` like any other refusal.
		"""
		wanted = max(1, min(int(limit), SEARCH_HYDRATION_MAX))
		filters = ["resultType:List(CONTENT)"]
		if date_posted in DATE_POSTED_FILTER:
			filters.insert(0, f"datePosted:List({DATE_POSTED_FILTER[date_posted]})")
		# Relevance is LinkedIn's default order, so only latest names one.
		if sort == "latest":
			filters.append("sortBy:List(date_posted)")
		fresh: list[str] = []
		offset = max(0, int(start))
		resume = offset
		exhausted = False
		previous: list[str] | None = None
		retried = False
		refused: VoyagerUnavailable | None = None
		# Whether the index has answered this search at all: on an earlier page
		# of this call, or on the pages before the cursor this call starts at.
		answered = offset > 0
		for _ in range(SEARCH_INDEX_REQUESTS_MAX):
			path = (
				f"/voyager/api/search/dash/clusters?q=all&query=(keywords:{quote(term, safe='')},"
				f"flagshipSearchIntent:SEARCH_SRP,queryParameters:({','.join(filters)}),"
				f"includeFiltersInResponse:false)&start={offset}&count={SEARCH_INDEX_PAGE}"
			)
			clusters: dict[str, Any] | None = None
			while clusters is None:
				try:
					clusters = await self._search_index(term, path)
				except VoyagerUnavailable as exc:
					if retried:
						refused = exc
						break
					retried = True
					await asyncio.sleep(SEARCH_RETRY_PAUSE_S)
			if clusters is None:
				break
			answered = True
			# Order matters — LinkedIn ranked these — so dedupe without sorting.
			urns: list[str] = []
			for found in re.findall(r"urn:li:(?:activity|ugcPost|share):\d+", json.dumps(clusters)):
				if found not in urns:
					urns.append(found)
			if not urns:
				# The index answered and listed nothing: the results ran out,
				# a finding about the search rather than a refusal. A search
				# with no results at all is said in the log.
				if offset == 0:
					print(f'[voyager] search "{term}": the index listed no posts', file=sys.stderr, flush=True)
				exhausted = True
				break
			# The same results at the next offset are an index ignoring `start`:
			# every later page would be these again, so the search ends here
			# rather than walking empty pages.
			if previous is not None and set(urns) == set(previous):
				exhausted = True
				break
			previous = urns
			unread = [urn for urn in urns if urn not in already_seen and urn not in fresh]
			room = wanted - len(fresh)
			fresh.extend(unread[:room])
			if len(unread) > room:
				# The next page reads this batch again; the seen set skips
				# what this page took from it.
				resume = offset
				break
			offset += SEARCH_INDEX_PAGE
			resume = offset
			if len(fresh) >= wanted:
				break
		if refused is not None:
			if not fresh and not answered and refused.status == 413:
				raise SidecarError(
					"SEARCH_TOO_LARGE",
					f'LinkedIn refused the search for "{term}" as too large, and again after a pause. '
					"Nothing was read from it.",
					retryable=True,
				)
			if not fresh:
				raise SidecarError(
					"SEARCH_UNAVAILABLE",
					f'LinkedIn refused the search for "{term}", and again after a pause. '
					"Nothing was read from it, and the next run searches it again.",
					retryable=True,
				)
			# What the pages before it found is read now; the refused page is
			# read again next time (`resume` already points at it).
		if not fresh:
			return [], resume, exhausted

		out: list[dict[str, Any]] = []
		for urn in fresh:
			try:
				payload = await self._voyager_get(
					f"/voyager/api/feed/updatesV2?q=backendUrnOrNss&urnOrNss={quote(urn, safe='')}&count=1",
					route_prefix=LINKEDIN_ORIGIN,
				)
			except VoyagerUnavailable as exc:
				print(f"[voyager] search hydration skipped {urn}: {exc}", file=sys.stderr, flush=True)
				continue
			rows = parse_updates(payload)
			if rows:
				out.append(rows[0])
		if not out:
			raise SidecarError(
				"SEARCH_UNAVAILABLE",
				f'None of the posts LinkedIn listed for "{term}" could be read. '
				"Nothing was taken from this search, and the next run searches it again.",
				retryable=True,
			)
		return [self._wire_post(row) for row in out], resume, exhausted

	async def _search_index(self, term: str, path: str) -> dict[str, Any]:
		"""One page of a search's urn index. A browser session's first waits
		for the session to warm (`_await_search_session`); a refusal is logged
		with the search's term and LinkedIn's status, and raised for the caller
		to ask once more or give up on."""
		if self._search_session != self._session_id:
			await self._await_search_session()
			self._search_session = self._session_id
		try:
			return await self._voyager_get(path, route_prefix=LINKEDIN_ORIGIN)
		except VoyagerUnavailable as exc:
			print(f'[voyager] search "{term}" refused: {exc}', file=sys.stderr, flush=True)
			raise

	async def _await_search_session(self) -> None:
		"""Hold a browser session's first index request until the session has
		warmed: the browser up SEARCH_WARMUP_S, and the page carrying the csrf
		cookie the request is signed with. Bounded: a session still not ready
		by then asks anyway, and the refusal it meets is the answer."""
		if self._started_at is not None:
			await asyncio.sleep(max(0.0, self._started_at + SEARCH_WARMUP_S - time.monotonic()))
		assert self._page is not None
		for _ in range(SEARCH_SESSION_CHECKS):
			try:
				if await self._page.evaluate(SEARCH_SESSION_JS) == "ready":
					return
			except Exception:  # noqa: BLE001 — the request itself will say what is wrong
				return
			await asyncio.sleep(SEARCH_SESSION_CHECK_S)

	def _post_url(self, post_urn: str) -> str:
		if not re.fullmatch(r"urn:li:(?:activity|ugcPost|share):[A-Za-z0-9_-]+", post_urn):
			raise SidecarError("INVALID_POST_URN", "postUrn is not a supported LinkedIn post URN")
		return f"{LINKEDIN_ORIGIN}/feed/update/{quote(post_urn, safe=':')}/"

	def _source_url(self, params: dict[str, Any]) -> str:
		term = str(params["term"])
		kind = params.get("kind", "search")
		if kind == "search":
			query: dict[str, str] = {"keywords": term, "origin": "GLOBAL_SEARCH_HEADER"}
			# Relevance — LinkedIn's Top match — is the page's own default, so
			# only latest names a sort. It used to be named on every search,
			# and newest-first returned mostly noise for a narrow audience.
			if params.get("sort") == "latest":
				query["sortBy"] = '"date_posted"'
			if params.get("datePosted") in DATE_POSTED_FILTER:
				query["datePosted"] = json.dumps(DATE_POSTED_FILTER[params["datePosted"]])
			return f"{LINKEDIN_ORIGIN}/search/results/content/?{urlencode(query)}"
		if kind != "author":
			raise SidecarError("INVALID_REQUEST", "kind must be search or author")
		if term.startswith("/in/"):
			path = term
		elif term.startswith(("https://www.linkedin.com/in/", "https://linkedin.com/in/")):
			parsed = urlparse(term)
			path = parsed.path
		elif re.fullmatch(r"[A-Za-z0-9_-]+", term):
			path = f"/in/{term}/"
		else:
			raise SidecarError(
				"UNSUPPORTED_AUTHOR_IDENTIFIER",
				"author discovery currently requires a LinkedIn /in/ URL or public slug",
			)
		return f"{LINKEDIN_ORIGIN}{path.rstrip('/')}/recent-activity/all/"

	def _cursor_key(self, params: dict[str, Any]) -> str:
		"""What a cursor is a place in: one term, read one way. A new sort or
		window is a different result list, so its cursor reads as expired."""
		material = json.dumps(
			{
				"term": params["term"],
				"kind": params.get("kind", "search"),
				"datePosted": params.get("datePosted"),
				"sort": params.get("sort") or "relevance",
			},
			separators=(",", ":"),
			sort_keys=True,
		)
		return hashlib.sha256(material.encode()).hexdigest()

	def _decode_cursor(self, cursor: str, key: str) -> tuple[set[str], int] | None:
		"""The posts a search already returned, and where its index resumes."""
		try:
			padding = "=" * (-len(cursor) % 4)
			value = json.loads(base64.urlsafe_b64decode(cursor + padding))
			if value.get("v") != 1 or value.get("key") != key or float(value.get("expiresAt", 0)) < time.time():
				return None
			seen = value.get("seen")
			if not isinstance(seen, list) or len(seen) > 500 or not all(isinstance(item, str) for item in seen):
				return None
			start = value.get("start", 0)
			if not isinstance(start, int) or isinstance(start, bool) or start < 0:
				return None
			return set(seen), start
		except (ValueError, TypeError, json.JSONDecodeError):
			return None

	def _encode_cursor(self, key: str, seen: set[str], start: int = 0) -> str:
		value = {
			"v": 1,
			"key": key,
			"seen": sorted(seen)[-500:],
			"start": start,
			"expiresAt": int(time.time()) + CURSOR_TTL_SECONDS,
		}
		raw = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
		return base64.urlsafe_b64encode(raw).decode().rstrip("=")

	async def _collect_posts(self, limit: int, *, already_seen: set[str] | None = None) -> tuple[list[dict[str, Any]], bool]:
		seen = set(already_seen or ())
		out: list[dict[str, Any]] = []
		stagnant = 0
		for _ in range(MAX_DISCOVERY_SCROLLS):
			rows = await self._evaluate_json(POSTS_JS)
			before = len(seen)
			for row in rows:
				urn = row.get("postUrn")
				if not isinstance(urn, str) or urn in seen:
					continue
				seen.add(urn)
				out.append(self._wire_post(row))
				if len(out) >= limit:
					return out, False
			stagnant = stagnant + 1 if len(seen) == before else 0
			assert self._page is not None
			at_bottom = await self._page.evaluate(
				"() => Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight"
			)
			if stagnant >= 2 and at_bottom == "True":
				return out, True
			await self._page.evaluate("() => { window.scrollBy(0, Math.max(600, window.innerHeight * 0.85)); return true; }")
			await asyncio.sleep(0.5)
		return out, False

	def _wire_post(self, row: dict[str, Any]) -> dict[str, Any]:
		"""Drop DOM nulls that are invalid for DriverPost's optional fields."""
		post: dict[str, Any] = {
			"postUrn": str(row["postUrn"]),
			"contentText": str(row.get("contentText") or ""),
		}
		for field in ("authorProfileId", "authorName", "authorHeadline", "url", "detectedLanguage", "authorGeo"):
			value = row.get(field)
			if isinstance(value, str) and value:
				post[field] = (
					normalize_author_profile_id(value) if field == "authorProfileId" else value
				)
		if not post.get("authorProfileId"):
			post.pop("authorProfileId", None)
		if isinstance(row.get("authorIsCompany"), bool):
			post["authorIsCompany"] = row["authorIsCompany"]
		posted_at = row.get("postedAt")
		if isinstance(posted_at, (int, float)) and not isinstance(posted_at, bool) and posted_at >= 0:
			post["postedAt"] = int(posted_at)
		for field in ("media", "metrics"):
			if row.get(field) is not None:
				post[field] = row[field]
		return post

	async def discover_posts(self, params: dict[str, Any]) -> dict[str, Any]:
		await self._assert_ready()
		key = self._cursor_key(params)
		cursor = params.get("cursor")
		already_seen: set[str] = set()
		start = 0
		if cursor:
			decoded = self._decode_cursor(str(cursor), key)
			if decoded is None:
				return {"posts": [], "nextCursor": None, "cursorState": "expired"}
			already_seen, start = decoded
			await self._page_turn_pause()
		source = self._source_url(params)
		await self._goto(source)
		await self._assert_landed_ready()

		limit = int(params["limit"])
		posts: list[dict[str, Any]] | None = None
		exhausted = True
		if params.get("kind") == "author":
			# Voyager-primary: one hydrated call, exact identity from the
			# permalink, and sponsored posts filtered — none of which the DOM can
			# do. Falls back rather than failing: activity pages still serve
			# legacy markup, so the scraper remains a working second path.
			try:
				parsed = urlparse(source)
				candidate = await self._voyager_author_posts(parsed.path, limit + len(already_seen))
				posts = [p for p in candidate if str(p["postUrn"]) not in already_seen][:limit]
				exhausted = len(candidate) < limit + len(already_seen)
			except VoyagerUnavailable as exc:
				print(f"[voyager] falling back to DOM: {exc}", file=sys.stderr, flush=True)
				posts = None
		elif params.get("kind") == "search":
			# The DOM is not a second path here, it is no path: a live search
			# results page exposed ONE post urn in its entire markup, because
			# search moved to server-driven UI. Voyager is the only way keyword
			# discovery returns anything at all, so a search it cannot answer
			# is raised as unavailable. Read off the DOM it came back as a page
			# with nothing on it and no cursor, which parked the source as dry.
			posts, start, exhausted = await self._voyager_search_posts(
				str(params["term"]),
				limit,
				sort=params.get("sort"),
				date_posted=params.get("datePosted"),
				start=start,
				already_seen=frozenset(already_seen),
			)

		if posts is None:
			posts, exhausted = await self._collect_posts(limit, already_seen=already_seen)
		all_seen = already_seen | {str(post["postUrn"]) for post in posts}
		return {
			"posts": posts,
			"nextCursor": None if exhausted else self._encode_cursor(key, all_seen, start),
			"cursorState": "active",
		}

	async def _page_turn_pause(self) -> None:
		await asyncio.sleep(PAGE_TURN_DELAY_MIN_S + random.random() * PAGE_TURN_DELAY_SPAN_S)

	async def read_post_thread(self, post_urn: str, max_comments: int, order: str = "RELEVANCE", start: int = 0) -> dict[str, Any]:
		"""One post in full, read from its own page — the read a person makes
		opening it — then the post's JSON and its most relevant comments.

		JSON only. A thread that will not answer is unavailable rather than
		scraped: a wrong `isOwner` or `authorReplied` would verify a post on
		facts that are not there, and an unverified match costs nothing.
		"""
		await self._assert_ready()
		if self._own_profile_url is None:
			await self.fetch_own_profile()
		own_profile_id = normalize_author_profile_id(self._own_profile_url or "")
		await self._goto(self._post_url(post_urn))
		await self._assert_landed_ready()
		route = f"{LINKEDIN_ORIGIN}/feed/update/"
		try:
			update = await self._voyager_get(
				f"/voyager/api/feed/updatesV2?q=backendUrnOrNss&urnOrNss={quote(post_urn, safe='')}&count=1",
				route_prefix=route,
			)
			comments = None
			if max_comments > 0:
				comments = await self._voyager_get(
					post_comments_address(comment_thread_ref(update, post_urn), start, order, max_comments),
					route_prefix=route,
				)
			return parse_post_thread(
				update,
				comments,
				post_urn=post_urn,
				own_profile_id=own_profile_id,
				max_comments=max_comments,
			)
		except VoyagerUnavailable as exc:
			raise SidecarError(
				"THREAD_UNAVAILABLE", f"the post could not be read: {exc}", retryable=not exc.gone
			) from exc

	async def read_author_profile(self, profile_id: str, role: bool = False) -> dict[str, Any]:
		"""A member's profile, read from their own page — a visit that can show
		on their list of who viewed their profile — then its JSON and their five
		latest posts. With `role`, their current role too, from their experience
		page (`_current_role`): one more page of theirs, opened as a reader
		opens it.

		A company identifier in URL form is answered without a visit: the
		verify stage rejects a company page whatever it says. A bare one is
		indistinguishable from a member's slug, so it is visited as one, and a
		company there reads as no member — unavailable, and not worth a retry.
		"""
		await self._assert_ready()
		slug = normalize_author_profile_id(profile_id)
		if not re.fullmatch(r"[a-z0-9_%\-\.]+", slug):
			raise SidecarError("INVALID_REQUEST", "profileId is not a LinkedIn public identifier or profile URL")
		if re.search(r"/(?:company|school)/", profile_id):
			return {"profileId": slug, "isCompanyPage": True, "recentPosts": []}
		route = f"{LINKEDIN_ORIGIN}/in/{slug}"
		await self._goto(f"{route}/")
		await self._assert_landed_ready()
		try:
			profile, profile_urn = await self._voyager_member_profile(slug, route)
			updates = await self._voyager_get(
				"/voyager/api/identity/profileUpdatesV2?includeLongTermHistory=true"
				f"&count={RECENT_POSTS_MAX}&profileUrn={quote(profile_urn, safe='')}&q=memberShareFeed",
				route_prefix=route,
			)
			read = parse_author_profile(profile, updates, profile_id=slug)
		except VoyagerUnavailable as exc:
			raise SidecarError(
				"PROFILE_UNAVAILABLE", f"the profile could not be read: {exc}", retryable=not exc.gone
			) from exc
		if role and "currentRole" not in read:
			current = await self._current_role(route)
			if current:
				read["currentRole"] = current
		return read

	async def _current_role(self, route: str) -> dict[str, str] | None:
		"""The member's current role, as `experience.py` reads it: the company
		pages their activity links, taken from the profile page before leaving
		it, then their experience page. The profile is already read and paid
		for, so a page that does not load or reads as nothing costs the role
		alone: None, never a failed read."""
		try:
			await self._evaluate_json(SCROLL_TO_EXPERIENCE_JS)
			await asyncio.sleep(ROLE_SETTLE_S)
			traces = await self._evaluate_json(TRACES_JS)
			await self._goto(f"{route}/details/experience/")
			items: Any = []
			for _ in range(ROLE_POLLS):
				items = await self._evaluate_json(EXPERIENCE_JS)
				if items:
					break
				await asyncio.sleep(ROLE_SETTLE_S)
			return current_role(items, traces)
		except SidecarError as exc:
			print(f"[profile] the current role was not read ({exc.code})", file=sys.stderr, flush=True)
			return None

	async def read_company_page(self, company_ref: str) -> dict[str, Any]:
		"""A company's own page, read from the page itself — the visit a person
		makes to a company — then its organization JSON: name, size band,
		industry, About and followers, and nothing else. A read: nothing on the
		page is followed or pressed. A page that is not there, or not this one,
		is unavailable and not worth a retry.
		"""
		await self._assert_ready()
		slug = company_slug(company_ref)
		if slug is None:
			raise SidecarError("INVALID_REQUEST", "companyRef is not a LinkedIn company identifier or page URL")
		route = f"{LINKEDIN_ORIGIN}/company/{slug}"
		await self._goto(f"{route}/")
		await self._assert_landed_ready()
		if slug.isdigit():
			# A page asked for by its id (an experience entry links it so) lands
			# on its own address, which is what its data is keyed by.
			assert self._page is not None
			landed = company_slug(await self._page_url(self._page) or "")
			if landed is None or landed.isdigit():
				raise SidecarError("COMPANY_UNAVAILABLE", "the company page did not open on a page of its own", retryable=False)
			slug, route = landed, f"{LINKEDIN_ORIGIN}/company/{landed}"
		try:
			payload = await self._voyager_get(
				"/voyager/api/organization/companies"
				"?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12"
				f"&q=universalName&universalName={quote(slug, safe='')}",
				route_prefix=route,
			)
			return parse_company_page(payload, company_ref=slug)
		except VoyagerUnavailable as exc:
			raise SidecarError(
				"COMPANY_UNAVAILABLE", f"the company page could not be read: {exc}", retryable=not exc.gone
			) from exc

	async def read_comment_replies(
		self,
		post_urn: str,
		comment_urn: str,
		since_ms: int | None,
		limit: int,
		vouched_reply_urns: frozenset[str] = frozenset(),
		room_reply_urn: str | None = None,
	) -> dict[str, Any]:
		"""The replies directly under one of our comments.

		LinkedIn's own comment data for our comment's thread first
		(`comment_data.py`): one request per page of it, made from whatever
		LinkedIn page is open — the feed is opened first only where none is —
		and it answers where the post's page has ranked our comment out of
		view. Where that data does not answer, or not in a shape it reads, the
		post's page is read as before.

		The page read navigates the post, keeping the document it is served as,
		pages in top-level comments until our row renders, presses the replies
		control under OUR row only until every reply it holds is in the markup,
		then reads the page as markup — `replies.py` holds every rule, which
		replies answer ours told first by the page's own data
		(`thread_data.py`), and `vouched_reply_urns` are the replies a
		notification about our comment named. Read only: nothing pressed here
		writes, and a read that cannot finish is a failure, never a partial
		answer.
		"""
		own = await self._own_profile_id()
		self._comment_id_from_urn(comment_urn)
		try:
			result = await self._comment_data_replies(comment_urn, own, since_ms, limit)
		except VoyagerUnavailable as exc:
			print(f"[replies] the comment data did not answer ({exc}); reading the post's page", file=sys.stderr, flush=True)
		else:
			comment = result["comment"]
			print(
				f"[replies] comment_data: {comment['replyRows']} of {comment['replyCount']} replies read",
				file=sys.stderr,
				flush=True,
			)
			return result
		document = await self._open_post_keeping_document(post_urn)
		reading = await self._settle_thread(post_urn, comment_urn)
		result = comment_replies(
			reading,
			own_profile_id=own,
			since_ms=since_ms,
			limit=limit,
			observed_at=int(time.time() * 1000),
			vouched_reply_urns=vouched_reply_urns,
			room_reply_urn=room_reply_urn,
			threads=await self._page_threads(document),
		)
		comment = result["comment"]
		if comment.get("present"):
			print(
				f"[replies] {comment['repliesFrom']}: {comment['replyRows']} of {comment['replyCount']} replies read",
				file=sys.stderr,
				flush=True,
			)
		return result

	async def _comment_data_replies(
		self, comment_urn: str, own_profile_id: str, since_ms: int | None, limit: int
	) -> dict[str, Any]:
		"""Our comment's thread from LinkedIn's comment data, page by page while
		LinkedIn counts replies the pages so far did not list, to
		COMMENT_DATA_PAGES — or VoyagerUnavailable, for the page to answer."""
		pages = await self._comment_data_pages(comment_urn)
		return comment_data_replies(
			pages,
			comment_urn=comment_urn,
			own_profile_id=own_profile_id,
			since_ms=since_ms,
			limit=limit,
			observed_at=int(time.time() * 1000),
		)

	async def _comment_data_pages(self, comment_urn: str) -> list[DataPage]:
		"""The pages of replies LinkedIn's comment data holds for one comment —
		what `_comment_data_replies` reads and the reactions on them are read
		from."""
		await self._start()
		current = str(await self._page_url(self._page) or "")
		if not current.startswith(LINKEDIN_ORIGINS):
			await self._goto(FEED_URL)
			await self._assert_landed_ready()
			current = str(await self._page_url(self._page) or "")
		origin = next((origin for origin in LINKEDIN_ORIGINS if current.startswith(origin)), None)
		if origin is None:
			raise VoyagerUnavailable(f"no LinkedIn page to ask from: on {current!r}")
		pages: list[DataPage] = []
		while not pages or (wants_next_page(pages) and len(pages) < COMMENT_DATA_PAGES):
			start = sum(len(page.comments) for page in pages)
			body = await self._voyager_get(comment_data_address(comment_urn, start), route_prefix=origin)
			pages.append(comment_data_page(body, comment_urn))
		return pages

	async def _page_threads(self, document: str | None) -> PageThreads | None:
		"""The loaded post page's own thread data (`thread_data.py`): from the
		page where it still holds it, else from the document it was served as,
		else None — the markup is then read as it was before, never as "no
		replies"."""
		reasons: list[str] = []
		try:
			return page_threads(await self._evaluate_json(PAGE_DATA_JS))
		except Unrecognised as exc:
			reasons.append(f"page: {exc}")
		except SidecarError as exc:
			# What the page handed back was not JSON at all.
			if exc.code != "DOM_CHANGED":
				raise
			reasons.append(f"page: {exc.message}")
		if document is None:
			reasons.append("document: not kept")
		else:
			try:
				return page_threads({"script": script_from_document(document)})
			except Unrecognised as exc:
				reasons.append(f"document: {exc}")
		print(f"[replies] the page's own thread data was not read ({'; '.join(reasons)})", file=sys.stderr, flush=True)
		return None

	async def _open_post_keeping_document(self, post_urn: str, link_query: str | None = None) -> str | None:
		"""Open the post and keep the document LinkedIn served for it
		(`_open_keeping_document`) — opened with `link_query` where the caller
		holds LinkedIn's own link to a comment or a reply
		(`like_data.reply_link_query`), so that the document declares it."""
		url = self._post_url(post_urn) + (f"?{link_query}" if link_query else "")
		return await self._open_keeping_document(url, self._post_address(post_urn), "the post's")

	async def _on_page(
		self, url: str, address: re.Pattern[str], what: str, *, fresh: bool = False, max_age_s: float | None = None
	) -> PageVisit:
		"""The standing tab on the page a person would be on for `url`'s
		sake, as LinkedIn's own client is when it writes (`page_visit.py`):
		kept where it is when the tab is still on the page this session last
		opened it at, `fresh` is not asked and the visit is no older than
		`max_age_s` where that is given, else opened as any page view is, its
		document kept where it matches `address`. A write made through the
		API from it carries the headers its own client named it by
		(`_page_identity` since the visit's `opened_at`)."""
		visit = self._visit
		if (
			not fresh
			and visit is not None
			and visit.url == url
			and visit.session_id == self._session_id
			and (max_age_s is None or time.monotonic() - visit.opened_at <= max_age_s)
		):
			current = await self._page_url(self._page)
			if current is not None and same_page(current, url):
				return visit
		opened_at = time.monotonic()
		document = await self._open_keeping_document(url, address, what)
		assert self._session_id is not None
		self._visit = PageVisit(url=url, session_id=self._session_id, document=document, opened_at=opened_at)
		return self._visit

	async def _page_identity(self, since: float) -> dict[str, str]:
		"""The headers the open page's own client named it by on a request to
		LinkedIn's API since `since` (a monotonic time) — waited for as its
		load sends one, at most PAGE_IDENTITY_POLLS polls — or none, where it
		sent none in that time or the page is not listened to."""
		if self._network_tap.client is None:
			return {}
		for attempt in range(PAGE_IDENTITY_POLLS):
			found = self._page_identity_seen.since(since)
			if found is not None:
				return found
			if attempt < PAGE_IDENTITY_POLLS - 1:
				await asyncio.sleep(PAGE_IDENTITY_POLL_S)
		print("[page] the page's own client named it on no API request", file=sys.stderr, flush=True)
		return {}

	async def _open_keeping_document(self, url: str, address: re.Pattern[str], what: str) -> str | None:
		"""Open `url` on the page this sidecar holds and keep the document
		LinkedIn served for it (`_keep_document`)."""
		await self._start()
		assert self._page is not None
		return await self._keep_document(self._page, address, lambda: self._goto(url), what)

	async def _keep_document(
		self, page: Any, address: re.Pattern[str], navigate: Callable[[], Awaitable[None]], what: str
	) -> str | None:
		"""Load `page` by `navigate` and keep the document LinkedIn served for
		it — the navigation's own response at `address`, as text, which carries
		the page's data before the page discards it — or None where the
		browser kept none. Nothing is requested that the page did not request,
		and a page that cannot be listened to is loaded plainly: whether a
		document not kept is load-bearing is the caller's call."""
		assert self._browser is not None
		try:
			session = await self._browser.session_for(page.target_id)
			client, session_id = session.cdp_client, session.session_id
			await client.send.Network.enable(
				params={
					"maxResourceBufferSize": DOCUMENT_BUFFER_BYTES,
					"maxTotalBufferSize": 4 * DOCUMENT_BUFFER_BYTES,
				},
				session_id=session_id,
			)
		except Exception as exc:  # noqa: BLE001 — keeping the document is the caller's call
			print(f"[document] {what} document cannot be kept: {exc}", file=sys.stderr, flush=True)
			await navigate()
			return None
		self._network_tap.attach(client)
		capture = ResponseCapture(session_id=session_id, pattern=address, types=DOCUMENT_TYPES)
		self._network_tap.capture = capture
		try:
			await navigate()
			try:
				await asyncio.wait_for(capture.first_finished.wait(), timeout=DOCUMENT_CAPTURE_WAIT_S)
				return await response_text(client, session_id, capture.finished[0])
			except Exception as exc:  # noqa: BLE001 — keeping the document is the caller's call
				print(f"[document] {what} document was not kept: {exc!r}", file=sys.stderr, flush=True)
				return None
		finally:
			self._network_tap.capture = None

	async def read_notifications(self, start: int) -> dict[str, Any]:
		"""One page of the account's notification cards, as LinkedIn's own JSON —
		`notifications.py` holds every rule.

		The first page is the response the feed's own load fetches: the sidecar
		opens the feed and keeps that response as the page receives it
		(`_capture_json`), and /notifications/ is never opened, so the bell's
		unseen count stays the owner's to clear. LinkedIn's client does not
		fetch the cards on every load: one that received none within the wait
		has the first page fetched once, from the feed, at the address the
		page's own client last used — LinkedIn's own when it has been seen to
		use none. A later page (`start` > 0) is the request the notifications
		page makes as it scrolls — the first page's address at another offset,
		fetched from the feed in its own session. Read only: nothing is
		pressed, opened or marked.
		"""
		await self._assert_ready()
		if start == 0:
			captured = await self._capture_json(FEED_URL, NOTIFICATION_CARDS_RE, timeout=NOTIFICATION_CAPTURE_WAIT_S)
			await self._assert_landed_ready()
			if captured:
				self._notification_cards_url = captured[0].url
				print("[notifications] first page: passive", file=sys.stderr, flush=True)
				return notification_cards(captured[0].body)
			address = self._notification_cards_url or DEFAULT_NOTIFICATION_CARDS_ADDRESS
			try:
				body = await self._voyager_get(page_address(address, 0), route_prefix=FEED_URL)
			except VoyagerUnavailable as exc:
				raise SidecarError(
					"NOTIFICATIONS_UNAVAILABLE",
					f"the feed's load fetched no notification cards, and fetching them failed: {exc}",
					retryable=True,
				) from exc
			self._notification_cards_url = address
			print("[notifications] first page: fetched", file=sys.stderr, flush=True)
			return notification_cards(body)
		if self._notification_cards_url is None:
			raise SidecarError(
				"NOTIFICATIONS_UNAVAILABLE", "a later page of cards needs the first page read first", retryable=True
			)
		try:
			body = await self._voyager_get(page_address(self._notification_cards_url, start), route_prefix=FEED_URL)
		except VoyagerUnavailable as exc:
			raise SidecarError(
				"NOTIFICATIONS_UNAVAILABLE", f"a later page of cards could not be read: {exc}", retryable=True
			) from exc
		return notification_cards(body)

	async def _capture_json(
		self,
		url: str,
		pattern: re.Pattern[str],
		*,
		timeout: float,
		also: tuple[re.Pattern[str], ...] = (),
		grace: float = 0.0,
	) -> list[CapturedResponse]:
		"""Navigate to `url` and keep the JSON the load fetched for itself: every
		XHR or fetch response whose address matches `pattern`, or one of `also`,
		that has finished by the time the first matching `pattern` has (and
		`grace` seconds after it), in the order the page received them — or
		none, when the page fetched no response matching `pattern` within
		`timeout`. `capture.py` holds the mechanics; nothing is requested that
		the page did not request."""
		await self._start()
		assert self._browser is not None and self._page is not None
		try:
			session = await self._browser.session_for(self._page.target_id)
			client = session.cdp_client
			await client.send.Network.enable(session_id=session.session_id)
		except Exception as exc:
			raise SidecarError("BROWSER_TRANSIENT", f"could not listen to the page: {exc}", retryable=True) from exc
		self._network_tap.attach(client)
		capture = ResponseCapture(session_id=session.session_id, pattern=pattern, also=also)
		self._network_tap.capture = capture
		try:
			await self._goto(url)
			try:
				await asyncio.wait_for(capture.first_finished.wait(), timeout=timeout)
			except TimeoutError:
				return []
			if grace:
				await asyncio.sleep(grace)
			try:
				return [
					CapturedResponse(
						url=capture.received[request_id],
						body=await response_json(client, session.session_id, request_id),
						request_headers=capture.headers.get(request_id, {}),
					)
					for request_id in list(capture.finished)
				]
			except Exception as exc:
				raise SidecarError(
					"BROWSER_TRANSIENT", f"the page's response could not be read: {exc}", retryable=True
				) from exc
		finally:
			self._network_tap.capture = None

	async def _own_profile_id(self) -> str:
		"""The connected account's profile id — which replies are ours, and
		whether a comment is, both turn on it."""
		await self._assert_ready()
		if self._own_profile_url is None:
			await self.fetch_own_profile()
		own = profile_identity(self._own_profile_url)
		if own is None:
			raise SidecarError(
				"ACCOUNT_IDENTITY_UNAVAILABLE", "could not resolve the connected LinkedIn account", retryable=True
			)
		return own[0]

	async def _settled_thread(self, post_urn: str, comment_urn: str) -> ThreadReading:
		"""Open the post and load the thread under one comment until it settles:
		top-level comments paged in until the row renders, then the replies
		control under THAT row pressed until every reply it holds is in the
		markup. Every press is read-side."""
		await self._goto(self._post_url(post_urn))
		return await self._settle_thread(post_urn, comment_urn)

	async def _settle_thread(self, post_urn: str, comment_urn: str) -> ThreadReading:
		"""`_settled_thread` on a post page already opened."""
		await self._assert_landed_ready()
		assert self._page is not None
		await self._await_comment_list()
		comment_pages = expansions = 0
		while True:
			reading = read_thread(
				snapshot_from_page(await self._evaluate_json(SNAPSHOT_JS)),
				post_urn=post_urn,
				comment_urn=comment_urn,
			)
			if reading.wants_more_comments and comment_pages < REPLY_COMMENT_PAGES:
				comment_pages += 1
				pressed = await self._page.evaluate(LOAD_MORE_COMMENTS_JS) == "True"
			elif reading.wants_more_replies and expansions < REPLY_EXPANSIONS:
				expansions += 1
				outcome = await self._evaluate_json(EXPAND_REPLIES_JS, *expand_replies_args(comment_urn))
				pressed = isinstance(outcome, dict) and outcome.get("state") == "clicked"
			else:
				break
			if not pressed:
				break
			await asyncio.sleep(REPLY_EXPANSION_DELAY_S)
		return reading

	async def read_relationship(
		self, profile_id: str | None, profile_url: str | None, place: bool = False
	) -> dict[str, Any]:
		"""Where the connected account stands with one member, read off their page.

		Navigates to the member's own profile — a visit that can show on their
		list of who viewed their profile — keeps the document it is served as,
		and hands its data to `profile_data.py`. Read only: nothing on the page
		is pressed. A member is asked for by public identifier, by the id in
		their profile urn, or by `/in/` URL; a company page has no relationship
		to read, and is refused before any navigation.

		`place` also asks where they are (`_member_place`), from the page this
		read has already loaded.
		"""
		requested = profile_url if profile_url is not None else profile_id
		if requested is None or re.search(r"/(?:company|school)/", requested):
			raise SidecarError("INVALID_REQUEST", "a relationship is read from a member's profile: pass their identifier or /in/ URL")
		if profile_url is not None and profile_identity(profile_url) is None:
			raise SidecarError("INVALID_REQUEST", "profileUrl is not a LinkedIn profile URL")
		member = member_address(requested)
		if not re.fullmatch(r"[A-Za-z0-9_%\-\.]+", member):
			raise SidecarError("INVALID_REQUEST", "the member is not a LinkedIn public identifier or profile URL")
		read = await self._read_member(member)
		if place and (found := await self._member_place(member, read)) is not None:
			read["place"] = found
		return read

	async def _member_place(self, member: str, read: dict[str, Any]) -> dict[str, str] | None:
		"""Where the member a relationship read bound is, from their profile's
		location — the lookup a Research read of the profile makes
		(`_voyager_member_profile`), asked from the page the read loaded, so no
		second visit. Only a read that bound the member to their page is placed,
		and only by a lookup answering with the same profile urn. None — not
		looked, never an empty place — where it was not, or the lookup failed."""
		if not read["profile"]["verified"] or read["degree"] == "self":
			return None
		try:
			payload, _ = await self._voyager_member_profile(member, f"{LINKEDIN_ORIGIN}/in/{member}")
		except VoyagerUnavailable:
			return None
		return member_place(payload, read["profileUrn"])

	async def _read_member(self, member: str) -> dict[str, Any]:
		"""The relationship read of one member's own profile: who they are
		from the data in the document it is served as (`profile_data.py`),
		where the account stands with them from LinkedIn's relationship data
		for them where it answered (`member_relationship.py`). A landing off a
		member's page is gone for good; a document not kept, or holding no data
		this reads, is PROFILE_UNAVAILABLE and may read next time. Never a
		guess from the page's markup."""
		read, _, _ = await self._read_member_data(member)
		return read

	async def _own(self) -> Own:
		"""The connected account, as a profile page's data is compared with it:
		which page is the account's own turns on it."""
		if self._own_profile_url is None:
			await self.fetch_own_profile()
		own = profile_identity(self._own_profile_url)
		if own is None:
			raise SidecarError(
				"ACCOUNT_IDENTITY_UNAVAILABLE", "could not resolve the connected LinkedIn account", retryable=True
			)
		urn_id = self._own_profile_urn.removeprefix(PROFILE_URN_PREFIX) if self._own_profile_urn else None
		return Own(public_identifier=own[0], urn_id=urn_id, member_id=self._own_member_id)

	async def prepare_invitation(self, input_value: dict[str, Any], expected: dict[str, str]) -> dict[str, Any]:
		"""Everything short of the POST, and nothing that writes.

		Re-reads the member's own profile in this session — LinkedIn's
		relationship data for them, fetched from their page — and refuses
		unless it shows them as `expected` (`invitation_write.admit`), and
		where LinkedIn takes an invitation to them only with their email
		(`admit_member`); reads LinkedIn's compose view for the account's
		notes, from the same page, and refuses a note it names no limit for,
		one longer than it, or one the account has none left for
		(`admit_note`). What commit will POST is fixed here and journaled
		with the attempt: the invitation to the member by the profile urn the
		admitting read bound, with exactly the owner's note. Nothing is typed,
		pressed or sent; a page that would not answer refuses before it
		(PROFILE_UNAVAILABLE, retryable).
		"""
		profile_id = normalize_author_profile_id(input_value["profileId"])
		if not re.fullmatch(r"[a-z0-9_%\-\.]+", profile_id):
			raise SidecarError("INVALID_REQUEST", "the member is not a LinkedIn public identifier")
		relationship, _, member = await self._read_member_data(profile_id)
		if member is None:
			raise SidecarError(
				"PROFILE_UNAVAILABLE", "LinkedIn's relationship data for the member did not answer", retryable=True
			)
		admit(relationship, profile_id=profile_id, expected=expected)
		admit_member(member)
		try:
			view = compose_view(await self._voyager_get(COMPOSE_VIEW_PATH, route_prefix=MEMBER_URL_PREFIX))
		except VoyagerUnavailable as exc:
			raise SidecarError(
				"PROFILE_UNAVAILABLE", f"LinkedIn's invitation compose view did not answer: {exc}", retryable=True
			) from exc
		except Unrecognised as exc:
			raise InvitationRefused("note_limit_unread", f"LinkedIn's compose view was not read: {exc}") from exc
		limit = admit_note(view, input_value["note"])
		assert self._session_id is not None
		prepared = {
			"path": CREATE_INVITATION_PATH,
			"body": create_invitation_body(profile_urn=relationship["profileUrn"], note=input_value["note"]),
			"noteLimit": limit,
			"relationship": relationship,
			"sessionId": self._session_id,
		}
		await self.validate_prepared_invitation(input_value, prepared)
		return prepared

	async def validate_prepared_invitation(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> None:
		"""The POST is made from the member's own profile, as LinkedIn's
		client makes it from the page the person is on (`_on_page`): the tab
		kept on the profile prepare read, or opened on it again where it has
		left — in the browser session prepare read in, holding the session
		cookie the request is signed with. Writes nothing: a browser that
		restarted, or a page with no session, is PREPARED_UI_STALE before the
		journal holds the attempt as CLICKING."""
		await self._start()
		if self._session_id != prepared["sessionId"]:
			raise SidecarError("PREPARED_UI_STALE", "the browser restarted since the invitation was prepared")
		member = normalize_author_profile_id(input_value["profileId"])
		await self._on_page(f"{LINKEDIN_ORIGIN}/in/{member}/", PROFILE_DOCUMENT_ADDRESS, "the profile's")
		cookie = await self._evaluate_json(SESSION_COOKIE_JS)
		if not isinstance(cookie, dict) or cookie.get("ready") is not True:
			raise SidecarError("PREPARED_UI_STALE", "the page holds no LinkedIn session to send the invitation in")

	async def commit_prepared_invitation(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> dict[str, Any]:
		"""POST the invitation once, and read LinkedIn's answer to it.

		Called only once the journal holds the attempt as CLICKING; the account
		was probed and the page validated before that: the POST goes from the
		member's profile, carrying the headers that page's own client names it
		by. The invitation LinkedIn says it created is `confirmed`, with its
		receipt — and, beside it, the
		member's profile read again in this session until it shows the
		invitation pending (`_reread_relationship`), the read the conversation
		records; a read that does not, or fails, leaves none and the receipt
		stands. LinkedIn's stated refusal is `blocked`; anything else is
		`uncertain`, for a read of the member to settle (`resolve`). The POST
		is never repeated here."""
		headers = await self._page_identity(self._visit.opened_at) if self._visit is not None else {}
		posted_at = time.monotonic()
		outcome = invitation_outcome(
			await self._evaluate_json(
				SEND_INVITATION_JS,
				prepared["path"],
				invitation_wire_body(prepared["body"]),
				json.dumps(headers),
				INVITATION_SEND_TIMEOUT_MS,
			)
		)
		if outcome["state"] != "confirmed":
			return outcome
		receipt = invitation_receipt(
			outcome["invitation"],
			note=input_value["note"],
			sent_at=int(time.time() * 1000),
			session_id=prepared["sessionId"],
		)
		profile_id = normalize_author_profile_id(input_value["profileId"])
		admitted = prepared["relationship"]

		def shows_invitation(read: dict[str, Any]) -> bool:
			return sent(read, profile_id, admitted)

		relationship: dict[str, Any] | None = None
		try:
			with receipt_log("invite", posted_at) as log:
				read = await self._reread_relationship(
					profile_id, shows_invitation, log, posted_at + PROFILE_RECEIPT_BUDGET_S
				)
				shown = shows_invitation(read)
				log.answered({"state": "shown" if shown else "not_shown"})
				relationship = read if shown else None
		except Exception as exc:  # noqa: BLE001 — LinkedIn's answer is the receipt; the read only accompanies it
			print(f"[invitation] the read beside the receipt failed: {exc!r}", file=sys.stderr, flush=True)
		return {"state": "confirmed", "receipt": receipt, "relationship": relationship}

	async def prepare_withdrawal(self, input_value: dict[str, Any], tag: str) -> dict[str, Any]:
		"""Everything short of the press, and nothing that withdraws.

		Re-reads the member's own profile in this session and refuses unless its
		data shows our invitation pending (`invitation_withdraw.admit`); binds
		the one control the page renders under the key the data names for the
		member's Pending — pressing the top card's More once, which opens a
		menu and sends nothing, where nothing renders under it yet — tags it,
		and checks over the page read again that the tag sits on exactly that
		control. A `Refused` leaves the page as it was found."""
		profile_id = normalize_author_profile_id(input_value["profileId"])
		if not re.fullmatch(r"[a-z0-9_%\-\.]+", profile_id):
			raise SidecarError("INVALID_REQUEST", "the member is not a LinkedIn public identifier")
		relationship = await self._read_member(profile_id)
		admit_withdrawal(relationship, profile_id=profile_id)
		key = pending_key(str(relationship["memberId"]))
		card = topcard_key(str(relationship["profileUrn"]).removeprefix(PROFILE_URN_PREFIX))
		await self._render_keyed_pending(profile_id, key, card)
		tagged = await self._evaluate_json(TAG_PENDING_JS, tag, key)
		if not isinstance(tagged, dict) or tagged.get("state") != "tagged":
			raise SidecarError("DOM_CHANGED", "the member's Pending could not be bound for the withdrawal")
		bound_control(keyed_snapshot_from_page(await self._evaluate_json(KEYED_SNAPSHOT_JS, key)), profile_id, key, tag)
		prepared = {"tag": tag, "key": key, "relationship": relationship}
		await self.validate_prepared_withdrawal(input_value, prepared)
		return prepared

	async def _render_keyed_pending(self, member: str, key: str, card: str) -> None:
		"""The page once its top card has rendered and a control renders under
		the Pending's `key` — in the card, or in the menu its More opens, which
		is pressed once, and only where nothing renders under the key yet.
		Drift where nothing ever does: the data says Pending, so the page not
		showing it is a layout this module does not know, never "not pending"."""
		snapshot = await self._rendered_card(card)
		keyed = keyed_snapshot_from_page(await self._evaluate_json(KEYED_SNAPSHOT_JS, key))
		if keyed_control(keyed, member, key) is not None:
			return
		more_control(snapshot, member, card)
		opened = await self._evaluate_json(PRESS_MORE_JS, card, MORE_CONTROL_RE.pattern)
		if not isinstance(opened, dict) or opened.get("state") != "clicked":
			raise SidecarError("DOM_CHANGED", "the member's More could not be opened for the withdrawal")
		for _ in range(WITHDRAW_MENU_ATTEMPTS):
			await asyncio.sleep(WITHDRAW_MENU_DELAY_S)
			keyed = keyed_snapshot_from_page(await self._evaluate_json(KEYED_SNAPSHOT_JS, key))
			if keyed_control(keyed, member, key) is not None:
				return
		raise SidecarError(
			"UI_DRIFT", "the withdrawal's page structure was not recognised: nothing renders under the Pending's key"
		)

	async def validate_prepared_withdrawal(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> None:
		"""The tagged control is still the one under the Pending's key, enabled.
		Presses nothing."""
		state = await self._evaluate_json(PRESS_PENDING_JS, prepared["tag"], prepared["key"], "read")
		if not isinstance(state, dict) or state.get("state") != "ready":
			found = state.get("state") if isinstance(state, dict) else None
			raise SidecarError("PREPARED_UI_STALE", f"the prepared withdrawal changed before it was pressed ({found})")

	async def commit_prepared_withdrawal(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> dict[str, Any]:
		"""Press the bound Pending, then the confirmation's Withdraw, once each,
		and read what they did.

		Called only once the journal holds the attempt as CLICKING, the account
		probed just before it (`service.py`): the Pending control is pressed
		there too, for on a layout this module does not know it might withdraw
		at once. Then: no confirmation, or a Withdraw that
		could not be pressed, is answered by the member's profile read again; a
		refusal LinkedIn printed is `blocked`; a confirmation still open is
		`uncertain`; and a confirmation gone is answered by the profile read
		again in this session — the member the admitting read bound, their
		switch on Withdrawn or back on Connect, is `confirmed`, connected is
		`connected`, anything else `uncertain`."""
		profile_id = normalize_author_profile_id(input_value["profileId"])
		admitted = prepared["relationship"]
		opened = await self._evaluate_json(PRESS_PENDING_JS, prepared["tag"], prepared["key"], "click")
		if not isinstance(opened, dict) or opened.get("state") != "clicked":
			found = opened.get("state") if isinstance(opened, dict) else None
			raise SidecarError("PREPARED_UI_STALE", f"the prepared withdrawal changed before it was pressed ({found})")
		pressed_at = time.monotonic()
		confirmation = None
		for _ in range(WITHDRAW_CONFIRMATION_ATTEMPTS):
			await asyncio.sleep(WITHDRAW_CONFIRMATION_DELAY_S)
			await self._assert_unchallenged("the withdrawal")
			confirmation = withdraw_confirmation(invitation_snapshot_from_page(await self._evaluate_json(INVITATION_SNAPSHOT_JS)))
			if confirmation is not None:
				break
		if confirmation is None:
			return await self._withdrawal_read_back(
				profile_id, admitted, "the withdraw confirmation never opened", pressed_at
			)
		pressed = await self._evaluate_json(CONFIRM_WITHDRAW_JS, WITHDRAW_WORDS_RE.pattern, WITHDRAW_LABEL_RE.pattern)
		if not isinstance(pressed, dict) or pressed.get("state") != "clicked":
			found = pressed.get("state") if isinstance(pressed, dict) else None
			return await self._withdrawal_read_back(
				profile_id, admitted, f"the confirmation's Withdraw was not pressed ({found})", pressed_at
			)
		pressed_at = time.monotonic()
		closed = False
		for _ in range(WITHDRAW_SETTLE_ATTEMPTS):
			await asyncio.sleep(WITHDRAW_SETTLE_DELAY_S)
			await self._assert_unchallenged("the withdrawal")
			outcome = after_withdraw(invitation_snapshot_from_page(await self._evaluate_json(INVITATION_SNAPSHOT_JS)))
			if isinstance(outcome, tuple):
				return {"state": "blocked", "detail": outcome[1]}
			if outcome == "closed":
				closed = True
				break
		if not closed:
			return {"state": "uncertain", "error": "the withdraw confirmation was still open after Withdraw", "relationship": None}
		return await self._withdrawal_read_back(
			profile_id, admitted, "the profile still shows the invitation pending", pressed_at
		)

	async def _withdrawal_read_back(
		self, profile_id: str, admitted: dict[str, Any], unsettled: str, pressed_at: float
	) -> dict[str, Any]:
		"""The member's profile read again in this session until it shows a
		withdrawal's answer (`_reread_relationship`): the member the admitting
		read bound on Withdrawn, or back on Connect, is `confirmed`, connected
		is `connected`, and anything else — `unsettled` says why it was read —
		`uncertain`. `pressed_at` is the monotonic time of the last press."""

		def settled(read: dict[str, Any]) -> bool:
			return withdrawn(read, profile_id, admitted) or connected_member(read, profile_id, admitted)

		with receipt_log("withdraw", pressed_at) as receipt:
			relationship = await self._reread_relationship(
				profile_id, settled, receipt, pressed_at + PROFILE_RECEIPT_BUDGET_S
			)
			if withdrawn(relationship, profile_id, admitted):
				return receipt.answered({"state": "confirmed", "relationship": relationship})
			if connected_member(relationship, profile_id, admitted):
				return receipt.answered({"state": "connected", "relationship": relationship})
			return receipt.answered({"state": "uncertain", "error": unsettled, "relationship": relationship})

	async def _rendered_card(self, card: str) -> ProfileSnapshot:
		"""The profile page as markup once the top card its data keys `card`
		has rendered — what a press on it is bound within — or as it stands
		after the last read, for the binding to refuse."""
		snapshot = profile_snapshot_from_page(await self._evaluate_json(PROFILE_SNAPSHOT_JS))
		for _ in range(PROFILE_HYDRATION_ATTEMPTS - 1):
			if card_of(snapshot, card) is not None:
				break
			await asyncio.sleep(PROFILE_HYDRATION_DELAY_S)
			snapshot = profile_snapshot_from_page(await self._evaluate_json(PROFILE_SNAPSHOT_JS))
		return snapshot

	async def _reread_relationship(
		self, member: str, holds: Callable[[dict[str, Any]], bool], receipt: ReceiptLog, deadline: float
	) -> dict[str, Any]:
		"""A write's receipt that is the member's profile, which trails the
		write: wait `PROFILE_RECEIPT_DELAY_S` and read it, and wait and read it
		again until `holds` of a read — at most `PROFILE_RECEIPT_READS` reads,
		none begun after `deadline` (a monotonic time). A read that holds ends
		it at once.

		Returns the last read. Every read is read-only and nothing is pressed
		between them. A challenge or any wall ends the receipt, for each read
		probes the session first (`read_relationship`), and so does a failure
		of the first read, as a single read would; a later read that fails for
		want of a page (`PROFILE_RECEIPT_RETRY_CODES`) leaves the last clean
		read the answer. `receipt` counts the reads, raised or not."""
		relationship: dict[str, Any] | None = None
		for _ in range(PROFILE_RECEIPT_READS):
			if relationship is not None and time.monotonic() + PROFILE_RECEIPT_DELAY_S > deadline:
				break
			await asyncio.sleep(PROFILE_RECEIPT_DELAY_S)
			receipt.read()
			try:
				relationship = await self.read_relationship(member, None)
			except SidecarError as exc:
				if relationship is None or exc.code not in PROFILE_RECEIPT_RETRY_CODES:
					raise
				continue
			if holds(relationship):
				break
		assert relationship is not None
		return relationship

	async def _assert_unchallenged(self, what: str) -> None:
		status = await self._session_snapshot()
		if status.get("checkpoint") or status.get("restricted"):
			raise SidecarError("CHECKPOINT_REQUIRED", f"LinkedIn challenged {what}", rate_limited=True)

	async def _received_invitations(self) -> ReceivedInvitations:
		"""The account's received invitations as its own invitations page's data
		states them (`invitations_data.py`) — what a read lists and what an
		acceptance is admitted on. Read only: nothing on the page is pressed, and
		nobody sees the account look at its own list.

		A page whose document was not kept, or that carries no data, is
		INVITATIONS_UNAVAILABLE — retryable, and never "no invitations"."""
		await self._assert_ready()
		document = await self._open_keeping_document(INVITATIONS_URL, INVITATIONS_DOCUMENT_RE, "the invitations page's")
		await self._assert_landed_ready()
		if document is None:
			raise SidecarError("INVITATIONS_UNAVAILABLE", "the invitations page's document was not kept", retryable=True)
		try:
			script = script_from_document(document)
		except Unrecognised as exc:
			raise SidecarError(
				"INVITATIONS_UNAVAILABLE", f"the invitations page carries no data: {exc}", retryable=True
			) from None
		try:
			values = flight_values(flight_from_page({"script": script}))
		except Unrecognised as exc:
			raise SidecarError("UI_DRIFT", f"the invitations page's data was not recognised: {exc}") from None
		return received_invitations(values)

	async def read_incoming_invitations(self, since_ms: int | None, limit: int) -> dict[str, Any]:
		"""The invitations people sent the connected account, from the data its
		own invitations page is served with. The data dates no invitation, so
		`since` leaves none out."""
		page = await self._received_invitations()
		assert self._session_id is not None
		return invitations_read(page, limit=limit, observed_at=int(time.time() * 1000), session_id=self._session_id)

	async def prepare_acceptance(self, input_value: dict[str, Any], tag: str) -> dict[str, Any]:
		"""Everything short of the press, and nothing that presses.

		Reads the invitations page's data afresh and refuses unless it lists the
		request, from the sender (`invitation_accept.admit`); then binds the one
		Accept in the row the data keys it by, tags it, and checks over the page
		read again that the tag sits on exactly that control. A row that never
		renders, or offers no single Accept, is a fault of the page with nothing
		pressed. A `Refused` leaves the page as it was found."""
		key = row_key(input_value["invitationId"])
		admit_acceptance(
			await self._received_invitations(),
			invitation_id=input_value["invitationId"],
			sender_id=input_value["senderProfileId"],
		)
		root = accept_snapshot_from_page(await self._evaluate_json(ACCEPT_SNAPSHOT_JS))
		for _ in range(ACCEPT_ROW_ATTEMPTS - 1):
			if accept_control(root, key) is not None:
				break
			await asyncio.sleep(ACCEPT_ROW_DELAY_S)
			root = accept_snapshot_from_page(await self._evaluate_json(ACCEPT_SNAPSHOT_JS))
		if accept_control(root, key) is None:
			raise SidecarError("DOM_CHANGED", "the request's row never rendered on the invitations page")
		tagged = await self._evaluate_json(TAG_ACCEPT_JS, tag, key, ACCEPT_CONTROL_RE.pattern)
		if not isinstance(tagged, dict) or tagged.get("state") != "tagged":
			raise SidecarError("DOM_CHANGED", "the request's Accept could not be bound for the acceptance")
		bound_accept(accept_snapshot_from_page(await self._evaluate_json(ACCEPT_SNAPSHOT_JS)), key, tag)
		prepared = {"tag": tag, "rowKey": key}
		await self.validate_prepared_acceptance(input_value, prepared)
		return prepared

	async def validate_prepared_acceptance(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> None:
		"""The tagged control is still the request's one Accept, enabled — in
		the row the request itself is keyed by, not one the prepared evidence
		merely names. Presses nothing."""
		key = row_key(input_value["invitationId"])
		if prepared.get("rowKey") != key:
			raise SidecarError("PREPARED_UI_STALE", "the prepared acceptance is bound to another request's row")
		state = await self._evaluate_json(PRESS_ACCEPT_JS, prepared["tag"], key, ACCEPT_CONTROL_RE.pattern, "read")
		if not isinstance(state, dict) or state.get("state") != "ready":
			found = state.get("state") if isinstance(state, dict) else None
			raise SidecarError("PREPARED_UI_STALE", f"the prepared acceptance changed before it was pressed ({found})")

	async def commit_prepared_acceptance(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> dict[str, Any]:
		"""Press the bound Accept once, then read what it did.

		Called only once the journal holds the attempt as CLICKING; the account
		was probed before that, so nothing here can fail for want of it. The
		control is re-checked and pressed in one renderer evaluation: refused
		there, it was never pressed (`not_pressed`). Pressed, the page is given
		time to send it — the row's Accept leaving — and the answer is
		`acceptance_read_back`'s, from the sender's profile read until it shows
		the Accept (`_reread_relationship`): it trails the press."""
		pressed = await self._evaluate_json(
			PRESS_ACCEPT_JS, prepared["tag"], prepared["rowKey"], ACCEPT_CONTROL_RE.pattern, "click"
		)
		if not isinstance(pressed, dict) or pressed.get("state") not in {"clicked", "control_changed", "control_disabled"}:
			raise SidecarError("WRITE_FAILED_AFTER_CLICK_START", "the Accept control answered nothing readable")
		if pressed["state"] != "clicked":
			return {"state": "not_pressed", "error": f"the prepared Accept changed before it was pressed ({pressed['state']})"}
		pressed_at = time.monotonic()
		for _ in range(ACCEPT_SETTLE_ATTEMPTS):
			await asyncio.sleep(ACCEPT_SETTLE_DELAY_S)
			await self._assert_unchallenged("the acceptance")
			try:
				root = accept_snapshot_from_page(await self._evaluate_json(ACCEPT_SNAPSHOT_JS))
			except SidecarError:
				continue
			if accept_left(root, prepared["rowKey"]):
				break
		sender = input_value["senderProfileId"]
		with receipt_log("accept", pressed_at) as receipt:
			relationship = await self._reread_relationship(
				sender, lambda read: sender_connected(read, sender), receipt, pressed_at + PROFILE_RECEIPT_BUDGET_S
			)
			return receipt.answered(await self.acceptance_read_back(input_value, relationship=relationship))

	async def acceptance_read_back(
		self, input_value: dict[str, Any], *, pages: int = 2, relationship: dict[str, Any] | None = None
	) -> dict[str, Any]:
		"""What an acceptance came to, read in this session and never pressed.

		The sender's own profile is the receipt: `1st` is `confirmed`. Where it
		shows anything else, the invitations page's data is read too — the row
		leaving it is evidence, never the receipt: still listed is
		`still_pending`, stamped with when that page was read; gone from a whole
		list, with the profile offering Connect and nothing pending, is
		`withdrawn` — they took it back; anything else `uncertain`. `pages` is
		how many page loads the caller has budgeted: one reads the profile
		alone, and leaves the data unread (`uncertain`) when it settled nothing.
		`relationship` is a read of the sender the caller has already made, in
		place of the one this makes.

		`withdrawn` is a verdict for a read long after the press. Right after
		it, a profile that has not caught up looks the same, so the commit
		never settles on it (`SidecarService._commit_acceptance`)."""
		sender = input_value["senderProfileId"]
		if relationship is None:
			relationship = await self.read_relationship(sender, None)
		if sender_connected(relationship, sender):
			return {"state": "confirmed", "relationship": relationship}
		if pages < 2:
			return {
				"state": "uncertain",
				"error": "the sender's profile does not show the Accept, and no read of the invitations page was budgeted",
				"relationship": relationship,
			}
		# Stamped before the load: the data is no newer than this.
		observed_at = int(time.time() * 1000)
		page = await self._received_invitations()
		if listed(page, invitation_id=input_value["invitationId"], sender_id=sender) is not None:
			return {"state": "still_pending", "relationship": relationship, "observedAt": observed_at}
		if page.complete and invitation_absent(relationship, sender):
			return {"state": "withdrawn", "relationship": relationship}
		return {
			"state": "uncertain",
			"error": "neither the sender's profile nor the invitations page shows what the Accept did",
			"relationship": relationship,
		}

	async def read_inbox(self, since_ms: int | None, limit: int) -> dict[str, Any]:
		"""The account's conversations, as LinkedIn's own JSON lists them —
		`conversations.py` holds every rule.

		Opens the compose view, which opens no conversation, and keeps the
		conversation list its own load fetches (`_capture_json`). Nothing is
		requested for it, and nothing is pressed, opened or marked: every
		conversation's unread state stays as the owner left it. A load that
		fetched no list is drift, never an empty inbox.
		"""
		own = await self._own_profile_id()
		body, mailbox = await self._conversation_data(own)
		assert self._session_id is not None
		read = conversation_list(
			body,
			mailbox=mailbox,
			own_profile_id=own,
			since_ms=since_ms,
			limit=limit,
			observed_at=int(time.time() * 1000),
		)
		return {**read, "sessionId": self._session_id}

	async def _conversation_data(self, own: str) -> tuple[Any, str]:
		"""The conversation list the compose view's own load fetches, as the
		page received it, and the account's mailbox its request names — kept
		with what a history read in the same page needs of it: every
		conversation as the list reads it, the page's own headers. The
		account's `/voyager/api/me`, where the same load fetched it first,
		must name the mailbox's member (`account_mailbox`). A load that fetched
		no list is drift, never an empty inbox."""
		captured = await self._capture_json(COMPOSE_URL, CONVERSATIONS_RE, timeout=INBOX_CAPTURE_WAIT_S, also=(ME_RE,))
		await self._assert_landed_ready()
		listed = next((response for response in captured if CONVERSATIONS_RE.search(response.url)), None)
		if listed is None:
			raise SidecarError(
				"UI_DRIFT",
				"the conversation list was not recognised: the messaging page's load fetched none",
				detail={"pageFingerprint": response_fingerprint(None), "selectorPack": SELECTOR_PACK_VERSION, "excerpt": ""},
			)
		me = next((response.body for response in captured if ME_RE.search(response.url)), None)
		mailbox = account_mailbox(listed.url, listed.body, me, own_profile_id=own)
		every = conversation_list(
			listed.body, mailbox=mailbox, own_profile_id=own, since_ms=None, limit=10_000, observed_at=0
		)
		self._mailbox = mailbox
		self._listed = {thread["threadId"]: thread for thread in every["threads"]}
		self._page_headers = {
			name: listed.request_headers[name] for name in PAGE_HEADERS if name in listed.request_headers
		}
		return listed.body, mailbox

	async def read_conversation_messages(
		self, thread_id: str, limit: int, members: Mapping[str, str] | None = None
	) -> dict[str, Any]:
		"""One conversation's newest messages, read from LinkedIn's own history
		for it WITHOUT opening it — `conversations.py` holds every rule.

		On the compose view, whose own load listed the conversation (loaded
		again where the page is elsewhere, or the conversation is not among
		those it listed), the page makes the GET its own messaging client makes
		for the newest page of the conversation's messages, with that client's
		headers; one page further back only where the first is full and short
		of `limit`. Nothing is pressed, opened or marked, and LinkedIn sends no
		receipt for it. Who is in the conversation is the list's word; every
		sender must be one of them. A status or an answer this module does not
		know is HISTORY_UNAVAILABLE — the caller opens the conversation instead.
		So is a member the list and the history link by member id alone whose
		profile `members` — member urn to profile id, what the caller learnt
		from a page read — does not name: who they are is the page's word.
		"""
		if not THREAD_ID_RE.fullmatch(thread_id):
			raise SidecarError("INVALID_REQUEST", "threadId is not a LinkedIn messaging thread id")
		own = await self._own_profile_id()
		if thread_id not in self._listed or not await self._on_compose_view():
			await self._conversation_data(own)
		listed = self._listed.get(thread_id)
		if listed is None or self._mailbox is None:
			raise SidecarError("HISTORY_UNAVAILABLE", "the conversation is not among those the inbox lists")
		urn = conversation_urn(self._mailbox, thread_id)
		participants = [_known_member(person, members or {}) for person in listed["participants"]]
		if any(person["profileId"] is None and "memberUrn" in person for person in participants):
			raise SidecarError("HISTORY_UNAVAILABLE", "a participant is known only by member id")
		try:
			messages, count, fingerprint = await self._history_page(urn, own, members, before=None)
			full = count >= HISTORY_PAGE
			if full and messages and len(messages) < limit:
				older, count, _ = await self._history_page(urn, own, members, before=messages[0]["sentAt"])
				known = {message["messageId"] for message in messages}
				messages = sorted(
					[message for message in older if message["messageId"] not in known] + messages,
					key=lambda message: message["sentAt"],
				)
				full = count >= HISTORY_PAGE
		except HistoryUnavailable as exc:
			raise SidecarError("HISTORY_UNAVAILABLE", f"history query id stale: {exc}") from None
		people = {person["profileId"] for person in participants if person["profileId"] is not None}
		if any(not message["fromSelf"] and message["authorProfileId"] not in people for message in messages):
			raise SidecarError("HISTORY_UNAVAILABLE", "a message's sender is not among those the list names")
		observed_at = int(time.time() * 1000)
		assert self._session_id is not None
		return {
			"threadId": thread_id,
			"participants": [
				{
					"profileId": own,
					"profileUrl": f"{LINKEDIN_ORIGIN}/in/{own}/",
					"displayName": self._own_display_name or "",
					"isSelf": True,
				},
				*({**person, "isSelf": False} for person in participants),
			],
			"group": listed["group"],
			"messages": [{**message, "observedAt": observed_at} for message in messages[-limit:]],
			# The whole history: a page that was not full reached its start.
			"complete": not full and len(messages) <= limit,
			"observedAt": observed_at,
			"sessionId": self._session_id,
			"pageFingerprint": fingerprint,
			"selectorPack": SELECTOR_PACK_VERSION,
		}

	async def _history_page(
		self, urn: str, own: str, members: Mapping[str, str] | None, *, before: int | None
	) -> tuple[list[dict[str, Any]], int, str]:
		"""One page of a conversation's history — its messages, how many it
		listed, the answer's shape fingerprint — by the query id the page's
		client was last seen to use for it."""
		query = self._messages_queries["latest" if before is None else "older"]
		body = await self._history_get(history_path(query, urn, before=before))
		assert self._mailbox is not None
		messages, count = conversation_history(
			body, urn=urn, mailbox=self._mailbox, own_profile_id=own, members=members
		)
		return messages, count, response_fingerprint(body)

	async def _history_get(self, path: str) -> Any:
		"""The page's own GET of `path`, made from the compose view and refused
		anywhere else: only what the page itself would fetch, where it would
		fetch it."""
		if not await self._on_compose_view():
			raise HistoryUnavailable("the page is not on the compose view")
		try:
			envelope = await self._evaluate_json(HISTORY_FETCH_JS, path, json.dumps(self._page_headers))
		except SidecarError as exc:
			raise HistoryUnavailable(f"the fetch failed: {exc.message}") from None
		if not isinstance(envelope, dict) or not envelope.get("ok"):
			status = envelope.get("status") if isinstance(envelope, dict) else None
			raise HistoryUnavailable(f"status {status}")
		try:
			return json.loads(envelope.get("body") or "")
		except (TypeError, json.JSONDecodeError):
			raise HistoryUnavailable("the answer is not JSON") from None

	async def _on_compose_view(self) -> bool:
		await self._start()
		assert self._page is not None
		return str(await self._page.get_url()).startswith(COMPOSE_URL)

	def _learn_page_request(self, url: str) -> None:
		"""Keep what the page's own client was just seen to ask for: a history
		query id, or the address of the notification cards."""
		learned = messages_query(url)
		if learned is not None:
			self._messages_queries[learned[0]] = learned[1]
		if NOTIFICATION_CARDS_RE.search(url):
			self._notification_cards_url = url

	async def _press_card(self, presses: UnreadRestore, card: str) -> str:
		"""The thread a card's press opened: the address the page settles on
		once the list marks that card, and no other, the active one — read the
		same twice running, so a redirect still landing is never taken for it.
		Refuses before pressing while any message composer is in use."""
		outcome = await self._evaluate_json(PRESS_CARD_JS, *press_card_args(card))
		state = outcome.get("state") if isinstance(outcome, dict) else None
		if state in {"composer_focused", "composer_holds_text"}:
			raise SidecarError(
				"COMPOSER_IN_USE",
				"a message composer is in use: the read stopped before moving the page off it",
			)
		was_active = outcome.get("wasActive") if isinstance(outcome, dict) else None
		if state != "pressed" or not isinstance(outcome.get("from"), str) or not isinstance(was_active, bool):
			raise presses.drift(card, f"a card could not be pressed ({state or 'no answer'})")
		before = thread_id_of(outcome["from"])
		landed: str | None = None
		for _ in range(CARD_OPEN_ATTEMPTS):
			await asyncio.sleep(CARD_OPEN_DELAY_S)
			page = await self._evaluate_json(LANDED_JS, *landed_args())
			now = press_landed(page, card, before=before, was_active=was_active)
			if now is not None and now == landed:
				return now
			landed = now
		raise presses.drift(card, "a card's press did not open its conversation")

	async def _restore_unread(self, presses: UnreadRestore, cards: list[str]) -> dict[str, bool]:
		"""Whether each card showed unread again after its restore. Each is
		tried once and never again: a press that might have landed is not
		repeated on a guess."""
		restored: dict[str, bool] = {}
		for card in cards:
			await self._jitter()
			try:
				restored[card] = await self._mark_unread(card)
			except SidecarError:
				restored[card] = False
		return restored

	async def _mark_unread(self, card: str) -> bool:
		"""Opens the card's menu, presses its one "Mark as unread", and re-reads
		the card for its unread mark. A menu without that item, or with more
		than one, is closed with Escape and nothing in it is pressed."""
		opened = await self._evaluate_json(OPEN_CARD_MENU_JS, *card_menu_args(card))
		if not isinstance(opened, dict) or opened.get("state") != "opened":
			return False
		for _ in range(CARD_MENU_ATTEMPTS):
			await asyncio.sleep(CARD_MENU_DELAY_S)
			found = await self._evaluate_json(MARK_UNREAD_JS, *mark_unread_args(card))
			state = found.get("state") if isinstance(found, dict) else None
			if state == "pressed":
				break
			if state != "none":
				await self._dismiss_menu()
				return False
		else:
			await self._dismiss_menu()
			return False
		for _ in range(UNREAD_CONFIRM_ATTEMPTS):
			await asyncio.sleep(CARD_MENU_DELAY_S)
			if card_shows_unread(messaging_snapshot_from_page(await self._evaluate_json(MESSAGING_SNAPSHOT_JS)), card):
				return True
		return False

	async def _dismiss_menu(self) -> None:
		"""Escape, the one key a restore presses: it closes an open menu."""
		await self._start()
		assert self._page is not None
		try:
			await self._page.press("Escape")
		except Exception as exc:
			raise SidecarError("BROWSER_TRANSIENT", f"could not close the card's menu: {exc}", retryable=True) from exc

	async def _jitter(self) -> None:
		await asyncio.sleep(CARD_PRESS_JITTER_MIN_S + random.random() * CARD_PRESS_JITTER_SPAN_S)

	async def read_dm_thread(
		self, thread_id: str, since_ms: int | None, *, restore_unread: bool = False
	) -> dict[str, Any]:
		"""One conversation — who is in it, its messages, and whether a draft
		waits in its composer — read off the thread's own page.

		Navigates to the thread, re-reads its markup until its header, a message
		and its composer render, and hands every rule to `messaging.py`. Nothing
		is scrolled or typed into, so older history is reported unloaded rather
		than loaded, and a draft is read from the markup and never touched.
		Opening it marks it seen; with `restore_unread` — the list showed it
		unread — the read then puts its unread mark back (`_restore_opened`) and
		says whether the card showed unread again.
		"""
		if not THREAD_ID_RE.fullmatch(thread_id):
			raise SidecarError("INVALID_REQUEST", "threadId is not a LinkedIn messaging thread id")
		own = await self._own_profile_id()
		await self._goto(f"{LINKEDIN_ORIGIN}/messaging/thread/{quote(thread_id, safe='')}/")
		await self._assert_landed_ready()
		snapshot = messaging_snapshot_from_page(await self._evaluate_json(MESSAGING_SNAPSHOT_JS))
		# Landed off the thread — one that is gone, or not this account's —
		# fails now, not after the wait for a thread that will never render.
		thread_page(snapshot, thread_id)
		for _ in range(THREAD_HYDRATION_ATTEMPTS - 1):
			if thread_rendered(snapshot):
				break
			await asyncio.sleep(THREAD_HYDRATION_DELAY_S)
			snapshot = messaging_snapshot_from_page(await self._evaluate_json(MESSAGING_SNAPSHOT_JS))
		assert self._session_id is not None
		read = dm_thread_read(
			snapshot,
			thread_id=thread_id,
			own_profile_id=own,
			own_display_name=self._own_display_name,
			own_member_urn=self._own_profile_urn,
			since_ms=since_ms,
			observed_at=int(time.time() * 1000),
			session_id=self._session_id,
		)
		if restore_unread:
			restored = await self._restore_opened(thread_id)
			read.update(markedSeen=True, unreadRestore="restored" if restored else "unread_restore_unconfirmed")
		return read

	async def _restore_opened(self, thread_id: str) -> bool:
		"""Whether the conversation open on the page showed unread again after
		the read put its mark back: a card that shows nothing unread pressed to
		move the page off it, then the opened card's one Mark as unread. Each
		is tried once and never again, and a page that does not single out the
		opened card, or offers nothing to move to, presses nothing."""
		snapshot = messaging_snapshot_from_page(await self._evaluate_json(MESSAGING_SNAPSHOT_JS))
		restore = unread_restore(snapshot, await self._evaluate_json(LANDED_JS, *landed_args()), thread_id)
		if restore is None or not restore.movers:
			return False
		try:
			await self._jitter()
			await self._press_card(restore, restore.movers[0])
		except SidecarError:
			return False
		return (await self._restore_unread(restore, [restore.card]))[restore.card]

	async def read_page_for_agent(self, target: AgentReadTarget) -> dict[str, Any]:
		"""One page as the agent reader's text (`agent_page.py`), for core to
		hand the owner's model and verify the answer against.

		The loads the parsers' reads already make, and nothing more: a post is
		settled as `read_comment_replies` settles it — comments paged in until
		our row renders, the replies control under OUR row pressed — and a
		conversation is opened and re-read until it renders. The inbox is the
		compose view, which opens no conversation: its text is the conversation
		list its load fetched (`json_representation`), the account named as
		the list links it — by its mailbox's member id (`account_mailbox`) —
		or, where it fetched none, the page, re-read until the list renders.
		Nothing else is pressed, typed or scrolled.
		"""
		own = await self._own_profile_id()
		focus: str | None = None
		if target.intent == "inbox":
			captured = await self._capture_json(
				target.url, CONVERSATIONS_RE, timeout=INBOX_CAPTURE_WAIT_S, also=(ME_RE,)
			)
			await self._assert_landed_ready()
			listed = next(
				(
					response
					for response in captured
					if CONVERSATIONS_RE.search(response.url) and response.body is not None
				),
				None,
			)
			if listed is not None:
				me = next((response.body for response in captured if ME_RE.search(response.url)), None)
				mailbox = account_mailbox(listed.url, listed.body, me, own_profile_id=own)
				snapshot = messaging_snapshot_from_page(await self._evaluate_json(MESSAGING_SNAPSHOT_JS))
				assert self._session_id is not None
				return {
					"intent": target.intent,
					"url": snapshot.url,
					# The list links the account, as everyone, by its member id.
					"ownProfileUrl": f"{LINKEDIN_ORIGIN}/in/{mailbox.removeprefix(PROFILE_URN_PREFIX).lower()}/",
					**json_representation(listed.body),
					"observedAt": int(time.time() * 1000),
					"sessionId": self._session_id,
					"pageFingerprint": response_fingerprint(listed.body),
					"selectorPack": SELECTOR_PACK_VERSION,
				}
		if target.intent == "comment_replies":
			assert target.post_urn is not None and target.comment_urn is not None
			reading = await self._settled_thread(target.post_urn, target.comment_urn)
			if reading.post_deleted:
				raise SidecarError("THREAD_UNAVAILABLE", "LinkedIn shows the post as deleted or removed")
			snapshot = reading.snapshot
			if not on_post_page(snapshot.url, target.post_urn):
				raise SidecarError("THREAD_UNAVAILABLE", "the post page did not load as the post", retryable=True)
			focus = target.comment_urn
		else:
			# The inbox's compose view is already loaded, by the capture.
			if target.intent != "inbox":
				await self._goto(target.url)
				await self._assert_landed_ready()
			snapshot = messaging_snapshot_from_page(await self._evaluate_json(MESSAGING_SNAPSHOT_JS))
			if target.thread_id is not None:
				thread_page(snapshot, target.thread_id)
			rendered = thread_rendered if target.thread_id is not None else inbox_rendered
			for _ in range(THREAD_HYDRATION_ATTEMPTS - 1):
				if rendered(snapshot):
					break
				await asyncio.sleep(THREAD_HYDRATION_DELAY_S)
				snapshot = messaging_snapshot_from_page(await self._evaluate_json(MESSAGING_SNAPSHOT_JS))
		assert self._session_id is not None
		return {
			"intent": target.intent,
			"url": snapshot.url,
			"ownProfileUrl": f"{LINKEDIN_ORIGIN}/in/{own}/",
			**page_representation(snapshot.root, focus=focus),
			"observedAt": int(time.time() * 1000),
			"sessionId": self._session_id,
			"pageFingerprint": page_fingerprint(snapshot.root),
			"selectorPack": SELECTOR_PACK_VERSION,
		}

	async def _conversation(self, thread_id: str) -> tuple[DmSnapshot, dict[str, Any]]:
		"""The conversation loaded afresh, as a DM reads it where its history
		cannot answer: its markup with every alert beside it, re-read until the
		thread renders, and the read `messaging.py` makes of it. A conversation
		LinkedIn will not carry a message in is its refusal, in LinkedIn's words,
		instead of a read."""
		if not THREAD_ID_RE.fullmatch(thread_id):
			raise SidecarError("INVALID_REQUEST", "threadId is not a LinkedIn messaging thread id")
		own = await self._own_profile_id()
		await self._goto(self._conversation_url(thread_id))
		await self._assert_landed_ready()
		snapshot = dm_snapshot_from_page(await self._evaluate_json(DM_SNAPSHOT_JS))
		thread_page(snapshot.page, thread_id)
		for _ in range(THREAD_HYDRATION_ATTEMPTS - 1):
			if thread_rendered(snapshot.page) or refusal_shown(snapshot) is not None:
				break
			await asyncio.sleep(THREAD_HYDRATION_DELAY_S)
			snapshot = dm_snapshot_from_page(await self._evaluate_json(DM_SNAPSHOT_JS))
		refused = refusal_shown(snapshot)
		if refused is not None:
			raise DmRefused("messaging_restricted", refused)
		assert self._session_id is not None
		read = dm_thread_read(
			snapshot.page,
			thread_id=thread_id,
			own_profile_id=own,
			own_display_name=self._own_display_name,
			own_member_urn=self._own_profile_urn,
			since_ms=None,
			observed_at=int(time.time() * 1000),
			session_id=self._session_id,
		)
		return snapshot, read

	async def prepare_dm(self, input_value: dict[str, Any], expected: dict[str, str], origin: str) -> dict[str, Any]:
		"""Everything short of the POST, and nothing that writes.

		Loads the account's conversation list as the compose view's own load
		fetches it — the mailbox its request names — and reads the
		conversation's history without opening it; where the list does not name
		it or its history cannot answer, the conversation's own page, loaded
		afresh (`_conversation`).
		Refuses unless that read is the account and the recipient alone — by
		the member urn `expected` names, the one the conversation is bound to —
		still at the message the DM was written after, with no one else's words
		in its composer where the read was its page (`dm_write.admit`). What
		commit will POST is fixed here and journaled with the attempt: the
		conversation's urn in that mailbox, and `origin`, the operation's
		token. Nothing is typed, pressed or sent."""
		thread_id = input_value["threadId"]
		recipient = input_value["recipientProfileId"]
		member_urn = expected.get("memberUrn")
		await self._conversation_data(await self._own_profile_id())
		read: dict[str, Any] | None = None
		if thread_id in self._listed:
			try:
				read = await self.read_conversation_messages(
					thread_id, HISTORY_PAGE, {member_urn: recipient} if member_urn else None
				)
			except SidecarError as exc:
				if exc.code not in HISTORY_FALLBACK_CODES:
					raise
		if read is None:
			_, read = await self._conversation(thread_id)
		admit_dm(
			read, recipient=recipient, member_urn=member_urn, after=expected["lastMessageId"], text=input_value["text"]
		)
		assert self._mailbox is not None and self._session_id is not None
		return {
			"conversationUrn": conversation_urn(self._mailbox, thread_id),
			"mailboxUrn": self._mailbox,
			"originToken": origin,
			"lastMessageId": expected["lastMessageId"],
			"sessionId": self._session_id,
		}

	async def validate_prepared_dm(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> None:
		"""The POST is made from the page a person sends the message from, as
		LinkedIn's client makes it (`_on_page`): the conversation's own page —
		or, for a first message, the member's profile, where its Message is —
		opened, or kept where the tab already is on it, in the browser session
		prepare read in, holding the session cookie the request is signed with.
		Writes nothing: any of it failing is PREPARED_UI_STALE, with what
		changed, before the journal holds the attempt as CLICKING."""
		await self._start()
		if self._session_id != prepared["sessionId"]:
			raise SidecarError("PREPARED_UI_STALE", "the browser restarted since the message was prepared")
		if "conversationUrn" in prepared:
			url, address, what = self._conversation_url(input_value["threadId"]), CONVERSATION_DOCUMENT_ADDRESS, "the conversation's"
		else:
			member = normalize_author_profile_id(input_value["recipientProfileId"])
			url, address, what = f"{LINKEDIN_ORIGIN}/in/{member}/", PROFILE_DOCUMENT_ADDRESS, "the profile's"
		try:
			await self._on_page(url, address, what)
		except SidecarError as exc:
			raise SidecarError(
				"PREPARED_UI_STALE", f"{what} page could not be opened to send from ({exc.code}: {exc.message})"
			) from exc
		cookie = await self._evaluate_json(SESSION_COOKIE_JS)
		if not isinstance(cookie, dict) or cookie.get("ready") is not True:
			raise SidecarError("PREPARED_UI_STALE", "the page holds no LinkedIn session to send the message in")

	async def _post_message(self, body: dict[str, Any]) -> Any:
		"""The one POST of `body` to LinkedIn's messaging API, from the page
		`validate_prepared_dm` opened, with the headers that page's own client
		names it by (`_on_page`). Never repeated: what it answered — or that it
		did not — is the caller's to read (`dm_write.send_outcome`)."""
		headers = await self._page_identity(self._visit.opened_at) if self._visit is not None else {}
		return await self._evaluate_json(
			SEND_MESSAGE_JS, CREATE_MESSAGE_PATH, wire_body(body), json.dumps(headers), SEND_TIMEOUT_MS
		)

	@staticmethod
	def _conversation_url(thread_id: str) -> str:
		return f"{LINKEDIN_ORIGIN}/messaging/thread/{quote(thread_id, safe='')}/"

	async def commit_prepared_dm(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> dict[str, Any]:
		"""POST the message once, and read LinkedIn's answer to it.

		Called only once the journal holds the attempt as CLICKING; the account
		was probed and the page validated before that, so nothing here can
		fail for want of either. The message LinkedIn says it created in this
		conversation, with these words, is `confirmed`; its stated refusal is
		`blocked`; anything else is `uncertain`, for the conversation's own
		read to settle (`dm_read_back`). Nothing is read and nothing retried
		here."""
		body = create_message_body(
			text=input_value["text"],
			mailbox_urn=prepared["mailboxUrn"],
			origin=prepared["originToken"],
			conversation_urn=prepared["conversationUrn"],
		)
		outcome = send_outcome(
			await self._post_message(body),
			mailbox_urn=prepared["mailboxUrn"],
			text=input_value["text"],
			origin=prepared["originToken"],
			thread_id=input_value["threadId"],
		)
		if outcome["state"] != "confirmed":
			return outcome
		return {
			"state": "confirmed",
			"receipt": posted_receipt(
				outcome["message"], observed_at=int(time.time() * 1000), session_id=prepared["sessionId"]
			),
		}

	async def prepare_open_dm(self, input_value: dict[str, Any], origin: str) -> dict[str, Any]:
		"""Everything short of the POST, and nothing that writes — `dm_open.py`
		holds every rule.

		Reads the member's own profile in this session: a connection, and the
		compose view their Message trigger navigates to. Reads the account's
		conversation list: none of it a 1:1 with them — and where that list is
		only its first page, the compose view's own lookup of their
		conversations must list none, or nothing is sent. Opens that compose
		view, keeping what its own load asks, which must name exactly them as
		the recipient, and LinkedIn's answer must not block the message nor
		make it a paid InMail. What commit will POST is fixed here: to their
		profile urn, from the mailbox the list named, under `origin`. A
		`Refused` sends nothing.
		"""
		recipient = input_value["recipientProfileId"]
		relationship, data, _ = await self._read_member_data(recipient)
		profile_urn = admit_open_dm(relationship, recipient=recipient)
		address = compose_address(data, profile_urn)
		own = await self._own_profile_id()
		body, mailbox = await self._conversation_data(own)
		listed = conversation_list(body, mailbox=mailbox, own_profile_id=own, since_ms=None, limit=10_000, observed_at=0)
		if existing_conversation(listed["threads"], recipient=recipient, profile_urn=profile_urn) is not None:
			raise OpenDmRefused("conversation_exists", "the conversation list holds a conversation with them")
		captured = await self._capture_json(
			address,
			compose_evidence_for(profile_urn),
			timeout=COMPOSE_CONTEXT_WAIT_S,
			also=(COMPOSE_CONTEXT_RE, COMPOSE_OPTIONS_RE, RECIPIENT_CONVERSATIONS_RE),
			grace=COMPOSE_CONTEXT_GRACE_S,
		)
		await self._assert_landed_ready()
		landed = str(await self._page_url(self._page) or "")
		if urlparse(landed).path != COMPOSE_PATH:
			raise OpenDmRefused("conversation_exists", "the compose view did not stay on compose")
		admit_compose_binding(landed, captured, profile_urn)
		found = lookup_conversations(captured, profile_urn)
		if found:
			raise OpenDmRefused("conversation_exists", "the compose view's own lookup finds a conversation with them")
		if found is None and listed["truncated"]:
			raise OpenDmRefused(
				"conversation_unverified",
				"the conversation list is only its first page, and the compose view's lookup did not rule one out",
			)
		assert self._session_id is not None
		return {"profileUrn": profile_urn, "mailboxUrn": mailbox, "originToken": origin, "sessionId": self._session_id}

	async def commit_prepared_open_dm(
		self, input_value: dict[str, Any], prepared: dict[str, Any], since_ms: int
	) -> dict[str, Any]:
		"""POST the first message once, as `commit_prepared_dm` posts one, to
		the member alone. The message LinkedIn says it created, with these
		words, in a conversation of its own is the receipt; the confirmation
		also carries that conversation, read from its history without opening
		it, for the caller to bind — a 1:1 with the member. A created message
		whose conversation cannot be read so is `uncertain`, naming the
		message, for the account's list to settle (`open_dm_read_back`).
		Called only once the journal holds the attempt as CLICKING."""
		recipient = input_value["recipientProfileId"]
		body = create_message_body(
			text=input_value["text"],
			mailbox_urn=prepared["mailboxUrn"],
			origin=prepared["originToken"],
			recipient_urn=prepared["profileUrn"],
		)
		outcome = send_outcome(
			await self._post_message(body),
			mailbox_urn=prepared["mailboxUrn"],
			text=input_value["text"],
			origin=prepared["originToken"],
			thread_id=None,
		)
		if outcome["state"] != "confirmed":
			return outcome
		created = outcome["message"]
		unread = f"LinkedIn created {created['messageId']}, but its conversation"
		try:
			read = await self.read_conversation_messages(
				created["threadId"], HISTORY_PAGE, {prepared["profileUrn"]: recipient}
			)
		except SidecarError as exc:
			return {"state": "uncertain", "error": f"{unread} was not read back: {exc.message}"[:500]}
		if opened_message(read, recipient=recipient, text=input_value["text"], since_ms=since_ms) is None:
			return {"state": "uncertain", "error": f"{unread} does not read as a 1:1 with them showing it"[:500]}
		found = posted_receipt(created, observed_at=read["observedAt"], session_id=prepared["sessionId"])
		return {
			"state": "confirmed",
			"receipt": {**found, "threadId": created["threadId"]},
			"conversation": conversation_of(read),
		}

	async def open_dm_read_back(
		self, recipient: str, profile_urn: str, since_ms: int
	) -> tuple[dict[str, Any] | None, bool]:
		"""The member's conversation as a first message's receipt reads it —
		the account's conversation list, loaded afresh, and the history of its
		1:1 with them, read without opening it — or None, with whether the list
		was whole since `since_ms`, which is what proves no conversation with
		them began."""
		own = await self._own_profile_id()
		body, mailbox = await self._conversation_data(own)
		listed = conversation_list(
			body,
			mailbox=mailbox,
			own_profile_id=own,
			since_ms=since_ms - OPEN_DM_CLOCK_SKEW_MS,
			limit=10_000,
			observed_at=int(time.time() * 1000),
		)
		thread = existing_conversation(listed["threads"], recipient=recipient, profile_urn=profile_urn)
		if thread is None:
			return None, listed["truncated"] is False
		read = await self.read_conversation_messages(thread["threadId"], HISTORY_PAGE, {profile_urn: recipient})
		return read, False

	async def _read_member_data(
		self, member: str
	) -> tuple[dict[str, Any], ProfileData, MemberRelationship | None]:
		"""The relationship read of one member's own profile (`_read_member`),
		the page's data it was read from, and LinkedIn's relationship data for
		them, fetched from that page (`_member_relationship`) — None where it
		did not answer, and the page's data stands for it."""
		await self._assert_ready()
		own = await self._own()
		profile = f"{LINKEDIN_ORIGIN}/in/{member}/"
		document = (await self._on_page(profile, PROFILE_DOCUMENT_ADDRESS, "the profile's", fresh=True)).document
		await self._assert_landed_ready()
		address = await self._page_url(self._page)
		if address is None:
			raise SidecarError("BROWSER_TRANSIENT", "the profile page reports no address", retryable=True)
		member_page(address)
		if document is None:
			raise SidecarError("PROFILE_UNAVAILABLE", "the profile page's document was not kept", retryable=True)
		try:
			data = profile_data(document_values(document))
		except Unrecognised as exc:
			raise SidecarError("PROFILE_UNAVAILABLE", f"the profile page's data was not read: {exc}", retryable=True) from exc
		related = await self._member_relationship(member)
		assert self._session_id is not None
		read = relationship_read(
			data,
			requested=member,
			own=own,
			observed_at=int(time.time() * 1000),
			session_id=self._session_id,
			member=related,
		)
		return read, data, related

	async def _member_relationship(self, member: str) -> MemberRelationship | None:
		"""Where the account stands with the member as LinkedIn's relationship
		data states it — the top card's own GET, made from their page
		(`member_relationship.py`) — or None where it did not answer: a fetch
		that failed, an answer this does not read. Data that contradicts
		itself is drift, raised."""
		try:
			payload = await self._voyager_get(top_card_path(member), route_prefix=MEMBER_URL_PREFIX)
			return member_relationship(payload, requested=member)
		except (VoyagerUnavailable, Unrecognised) as exc:
			print(f"[relationship] LinkedIn's relationship data did not answer: {exc}", file=sys.stderr, flush=True)
			return None

	async def dm_read_back(
		self, thread_id: str, members: Mapping[str, str] | None, *, limit: int
	) -> tuple[dict[str, Any], bool]:
		"""A conversation as a DM's receipt reads it, and whether that read is
		its history: LinkedIn's own message data, read without opening it — no
		seen receipt, no delivery acknowledgement — by the query id the page's
		client was last seen to use. Only where the history cannot answer — a
		query id LinkedIn renamed, a member no read has tied to a profile, a
		conversation list the reader does not recognise — is the conversation
		opened, which acknowledges delivery as any open does. A wall or a page
		that would not load ends the read, as it would the page's own."""
		try:
			return await self.read_conversation_messages(thread_id, limit, members), True
		except SidecarError as exc:
			if exc.code not in HISTORY_FALLBACK_CODES:
				raise
		return await self.read_dm_thread(thread_id, None), False

	async def fetch_own_posts(self, limit: int) -> list[dict[str, Any]]:
		if self._own_profile_url is None:
			await self.fetch_own_profile()
		assert self._own_profile_url is not None
		# /recent-activity/posts/ now renders nothing (measured: zero data-urn
		# elements). /recent-activity/all/ is the surface that still carries
		# posts, and it is the same route author discovery already proves.
		# Navigate BEFORE reading. Congruence is enforced against the loaded route,
		# so calling Voyager without moving there is refused by design — that is
		# what sent this path to the DOM fallback on its first live run.
		await self._goto(f"{self._own_profile_url}/recent-activity/all/")
		own = profile_identity(self._own_profile_url)
		if own is None:
			raise SidecarError("ACCOUNT_IDENTITY_UNAVAILABLE", "could not resolve the connected LinkedIn account", retryable=True)
		# Only posts the account wrote: no reposts (with or without a comment of
		# their own) and no company page's. The markup cannot tell those apart, so
		# when the data does not answer there is no DOM fallback, and no posts.
		def own_ids(profile_urn: str) -> frozenset[str]:
			# The account by every name its actor urn may carry: the public
			# identifier, the member number, the profile urn (as the profile
			# lookup and /me gave it) and its mini-profile twin.
			urns = {profile_urn, self._own_profile_urn or ""}
			ids = {own[0], *urns, *(u.replace(PROFILE_URN_PREFIX, "urn:li:fs_miniProfile:") for u in urns)}
			if self._own_member_id:
				ids.add(f"urn:li:member:{self._own_member_id}")
			return frozenset(ids - {""})

		try:
			return await self._voyager_author_posts(
				urlparse(self._own_profile_url).path,
				limit,
				accept=lambda row, profile_urn: owner_verdict(row, own_ids(profile_urn)),
			)
		except VoyagerUnavailable as exc:
			if exc.transient:
				# LinkedIn or the connection did not answer: the data was not seen,
				# so this is a read to try again, not data that cannot be read.
				raise SidecarError("BROWSER_TRANSIENT", f"the own posts could not be fetched: {exc}", retryable=True, rate_limited=exc.status == 429) from exc
			raise SidecarError("UI_DRIFT", f"the own posts' data was not recognised: {exc}") from exc

	async def fetch_own_comments(self, limit: int) -> OwnCommentsRead:
		"""The account's own comments, `{text, postUrn}`, from the data its
		comments activity page is served with (`own_comments.py`) — the first
		page as the document carries it, then each page after it
		(`_next_own_comments_page`), to OWN_COMMENT_PAGES and no further than
		`limit` needs. Read only, from the page a person would be on: no request
		is made that the page's own pager did not declare. No markup decides
		which comment is ours: a document not kept, or a page that does not
		follow or read, is an error. A page that is not there after the first
		is not: what was read comes back `incomplete`."""
		if self._own_profile_url is None:
			await self.fetch_own_profile()
		assert self._own_profile_url is not None
		own = profile_identity(self._own_profile_url)
		if own is None:
			raise SidecarError("ACCOUNT_IDENTITY_UNAVAILABLE", "could not resolve the connected LinkedIn account", retryable=True)
		url = f"{self._own_profile_url.rstrip('/')}/recent-activity/comments/"
		address = re.compile("^" + re.escape(url) + r"?(?:[?#]|$)", re.IGNORECASE)
		self._rsc_headers_seen.headers = {}
		visit = await self._on_page(url, address, "the own comments'", fresh=True)
		await self._assert_landed_ready()
		if visit.document is None:
			raise SidecarError("UI_DRIFT", "the comments activity page's document was not kept")
		self._own_comments_scroll = True
		self._own_comments_tab_lost = False
		self._own_comments_deadline = time.monotonic() + OWN_COMMENTS_PAGING_BUDGET_S
		try:
			return await read_own_comments(
				visit.document, own_identifier=own[0], limit=limit, next_page=self._next_own_comments_page
			)
		except Unrecognised as exc:
			raise SidecarError("UI_DRIFT", f"the comments activity page's data was not read: {exc}") from exc
		except PageUnavailable as exc:
			raise SidecarError(
				"BROWSER_TRANSIENT" if exc.transient else "UI_DRIFT",
				f"the comments activity page's next page was not had: {exc}",
				retryable=exc.transient,
			) from exc

	async def _next_own_comments_page(self, request: PageRequest) -> str:
		"""The flight of the page `request` (the one the page declared) asks
		for, as the page received it: the response LinkedIn's own pager makes
		when the activity page is scrolled to the end of its list, or — where the
		pager sends no request within OWN_COMMENTS_SCROLL_WAIT_S — the declared
		request made from the page itself (`_declared_own_comments_page`). Once
		the scroll yields nothing it is not tried again in this read. Whether a
		page that is not there is the end of the list is the data's to say
		(`own_comments.py`), never the absence of a response: it is
		PageUnavailable, as is a read past its OWN_COMMENTS_PAGING_BUDGET_S."""
		if self._own_comments_tab_lost:
			raise PageUnavailable("the comments activity tab was discarded")
		if self._own_comments_remaining() < 1:
			raise PageUnavailable("the read ran out of time", transient=True)
		if self._own_comments_scroll:
			body = await self._scrolled_own_comments_page()
			if body is not None:
				return body
			if self._own_comments_tab_lost:
				raise PageUnavailable("the comments activity tab was discarded")
			self._own_comments_scroll = False
			print("[own-comments] the pager sent no request; making the declared request", file=sys.stderr, flush=True)
		return await self._declared_own_comments_page(request)

	def _own_comments_remaining(self) -> float:
		return self._own_comments_deadline - time.monotonic()

	async def _scrolled_own_comments_page(self) -> str | None:
		"""Scroll the open comments activity page to the end of its list, with
		the page made to think it is focused, and keep the response LinkedIn's
		own pager then requests — or None where it sends no request in time.
		Once it has sent one, that request is waited for and no other is made.
		Nothing is requested that the page did not request (`capture.py`)."""
		await self._start()
		assert self._browser is not None and self._page is not None
		try:
			session = await self._browser.session_for(self._page.target_id)
			client, session_id = session.cdp_client, session.session_id
			await client.send.Network.enable(
				params={
					"maxResourceBufferSize": DOCUMENT_BUFFER_BYTES,
					"maxTotalBufferSize": 4 * DOCUMENT_BUFFER_BYTES,
				},
				session_id=session_id,
			)
		except Exception:  # noqa: BLE001 — a page that cannot be listened to is not scrolled for
			return None
		self._network_tap.attach(client)
		capture = ResponseCapture(session_id=session_id, pattern=OWN_COMMENTS_PAGER_RE)
		self._network_tap.capture = capture
		focus = False
		try:
			focus = True
			try:
				await client.send.Emulation.setFocusEmulationEnabled(params={"enabled": True}, session_id=session_id)
			except Exception as exc:  # noqa: BLE001 — the scroll is still tried, and the fallback is there
				print(f"[own-comments] focus emulation could not be turned on: {exc}", file=sys.stderr, flush=True)
			scrolled = await self._evaluate_json(SCROLL_ACTIVITY_LIST_JS)
			if not isinstance(scrolled, dict) or scrolled.get("scrolled") is not True:
				return None
			deadline = time.monotonic() + min(OWN_COMMENTS_SCROLL_WAIT_S, self._own_comments_remaining())
			while not capture.requested and time.monotonic() < deadline:
				await asyncio.sleep(0.25)
			if not capture.requested:
				return None
			# The pager has sent its request: wait it out, and send no other.
			wait = max(0.0, min(OWN_COMMENTS_PAGE_WAIT_S, self._own_comments_remaining()))
			try:
				await asyncio.wait_for(capture.first_finished.wait(), timeout=wait)
			except TimeoutError as exc:
				raise PageUnavailable("the pager's request was made and never answered", transient=True) from exc
			if capture.sizes.get(capture.finished[0], 0) > OWN_COMMENT_PAGE_BYTES:
				raise PageUnavailable("the pager's answer is larger than a page may be")
			try:
				body = await response_text(client, session_id, capture.finished[0])
			except Exception as exc:  # noqa: BLE001 — a body the browser dropped is not a page
				raise PageUnavailable(f"the pager's answer was not kept: {exc}", transient=True) from exc
		finally:
			self._network_tap.capture = None
			if focus:
				try:
					await asyncio.wait_for(
						client.send.Emulation.setFocusEmulationEnabled(params={"enabled": False}, session_id=session_id), 5
					)
				except Exception as exc:  # noqa: BLE001 — emulation not confirmed off is not left on a tab we keep
					print(f"[own-comments] focus emulation was not confirmed off: {exc}", file=sys.stderr, flush=True)
					await self._discard_own_comments_tab()
		if len(body) > OWN_COMMENT_PAGE_BYTES:
			raise PageUnavailable("the pager's answer is larger than a page may be")
		print(f"[own-comments] the next page arrived: {len(body)} characters", file=sys.stderr, flush=True)
		return body

	async def _discard_own_comments_tab(self) -> None:
		"""Close the tab focus emulation may still be on, and hold a new blank
		one: the read stops there (`_own_comments_tab_lost`), for the activity
		page is gone with it."""
		self._own_comments_tab_lost = True
		old, self._page, self._visit = self._page, None, None
		try:
			await self._replace_probe_page()
			if old is not None and self._browser is not None:
				await self._browser.close_page(old)
		except Exception as exc:  # noqa: BLE001 — a tab or browser that is gone has nothing left to unset
			print(f"[own-comments] the tab could not be discarded: {exc}", file=sys.stderr, flush=True)

	async def _declared_own_comments_page(self, request: PageRequest) -> str:
		"""The request the document declared for the next page, made from the
		page it was declared on, as the pager makes it (`OWN_COMMENTS_PAGE_JS`):
		the pager's own address, the body it declared (`PageRequest.body`), and
		the headers the page's own client named itself by on its earlier
		requests (`RscPageHeaders`, else `_page_identity`) beside the CSRF
		token. A header the page never named is not made up: without the page
		instance and track, nothing is sent. The answer is read as a stream and
		refused past OWN_COMMENT_PAGE_BYTES. A read, made once, never retried."""
		identity = await self._page_identity(self._visit.opened_at) if self._visit is not None else {}
		headers = {**identity, **self._rsc_headers_seen.headers}
		missing = [name for name in ("x-li-page-instance", "x-li-track") if name not in headers]
		if missing:
			raise PageUnavailable(f"the page named itself by no {', '.join(missing)} to make the request with")
		timeout_ms = int(min(OWN_COMMENTS_FETCH_TIMEOUT_MS, self._own_comments_remaining() * 1000))
		if timeout_ms < 1000:
			raise PageUnavailable("the read ran out of time", transient=True)
		try:
			answer = await self._evaluate_json(
				OWN_COMMENTS_PAGE_JS,
				PAGINATION_PATH,
				json.dumps(request.body(), separators=(",", ":")),
				json.dumps(headers),
				timeout_ms,
				OWN_COMMENT_PAGE_BYTES,
			)
		except SidecarError as exc:
			raise PageUnavailable(f"the page could not make the declared request: {exc}", transient=True) from exc
		status = answer.get("status") if isinstance(answer, dict) else None
		body = answer.get("body") if isinstance(answer, dict) else None
		print(
			f"[own-comments] declared request at {request.start_index} from the "
			f"{answer.get('frame', '?') if isinstance(answer, dict) else '?'} window, {len(headers)} page headers: "
			f"HTTP {status}, {len(body) if isinstance(body, str) else 0} characters",
			file=sys.stderr,
			flush=True,
		)
		if isinstance(answer, dict) and answer.get("tooLarge") is True:
			raise PageUnavailable("the declared request's answer is larger than a page may be")
		if not isinstance(status, int) or isinstance(status, bool) or status == 0:
			failed = answer.get("error") if isinstance(answer, dict) else None
			raise PageUnavailable(f"the declared request got no answer: {failed or 'no status'}", transient=True)
		if not 200 <= status < 300:
			raise PageUnavailable(f"the declared request was answered HTTP {status}", transient=status in {408, 425, 429} or status >= 500)
		if not isinstance(body, str):
			raise PageUnavailable("the declared request was answered with no body", transient=True)
		return body

	def _comment_id_from_urn(self, comment_urn: str) -> str:
		"""The trailing, globally-unique comment id. LinkedIn mints one comment urn
		in whichever inner post spelling it likes (activity vs ugcPost — the two
		ids are independently allocated, see postUrn.ts), so a comment is told by
		its id alone, never by the inner reference."""
		match = re.search(
			r"urn:li:comment:\((?:urn:li:)?(?:activity|ugcPost|share):[A-Za-z0-9_-]+,([A-Za-z0-9_-]+)\)$",
			comment_urn,
		)
		if match:
			return match.group(1)
		match = re.fullmatch(r"urn:li:comment:([A-Za-z0-9_-]+)", comment_urn)
		if match:
			return match.group(1)
		raise SidecarError("INVALID_REQUEST", "commentUrn is not a recognised LinkedIn comment urn")

	def _post_address(self, post_urn: str) -> re.Pattern[str]:
		"""The post's own address, its urn's colons as sent or percent-encoded:
		the document LinkedIn serves for it is kept by it."""
		return re.compile(
			"^" + re.escape(f"{LINKEDIN_ORIGIN}/feed/update/") + re.escape(post_urn).replace(":", "(?::|%3[Aa])")
		)

	async def _on_post_page(self, post_urn: str, link_query: str | None = None, *, fresh: bool = False) -> PageVisit:
		"""The post's own page, the one a comment, a reply or a like on it is
		made from (`_on_page`) — opened by LinkedIn's own link to the comment
		`link_query` names, where the write answers or likes one, so that the
		comment is in view. A comment's send is one visit with the reconcile read
		before it and the like after it: the page is kept for
		`POST_VISIT_REUSE_S`, as a person would stay on it."""
		url = self._post_url(post_urn) + (f"?{link_query}" if link_query else "")
		visit = await self._on_page(
			url, self._post_address(post_urn), "the post's", fresh=fresh, max_age_s=POST_VISIT_REUSE_S
		)
		await self._assert_landed_ready()
		return visit

	async def _post_thread(self, post_urn: str) -> PostThread:
		"""What LinkedIn's data for the post, read from the post's own page,
		says a write on it needs (`comment_write.post_thread`). A post LinkedIn
		says is gone is THREAD_UNAVAILABLE, not to be retried; one its data does
		not answer for now is THREAD_UNAVAILABLE to retry."""
		try:
			payload = await self._voyager_get(
				f"/voyager/api/feed/updatesV2?q=backendUrnOrNss&urnOrNss={quote(post_urn, safe='')}&count=1",
				route_prefix=f"{LINKEDIN_ORIGIN}/feed/update/",
			)
		except VoyagerUnavailable as exc:
			raise SidecarError(
				"THREAD_UNAVAILABLE", f"the post could not be read: {exc}", retryable=not exc.gone
			) from exc
		thread = post_thread(payload, post_urn)
		# The same answer keys the post's comment data (`_post_comment_pages`).
		self._thread_refs.setdefault(post_urn, comment_thread_ref(payload, post_urn))
		return thread

	async def prepare_comment(self, input_value: dict[str, Any]) -> dict[str, Any]:
		"""Everything short of the POST, and nothing that writes.

		Opens the post's own page and reads LinkedIn's data for it there: the
		thread its comments are keyed by — the approved post, or LinkedIn's own
		mapping of it — and that the account may comment on it
		(`comment_write.post_thread`). What commit will POST is fixed here and
		journaled with the attempt: that thread. Nothing is typed, pressed or
		sent."""
		post_urn = input_value["postUrn"]
		await self._assert_ready()
		await self._on_post_page(post_urn)
		post = await self._post_thread(post_urn)
		if not post.can_comment:
			raise SidecarError("COMMENTS_CLOSED", "LinkedIn does not let the account comment on the post")
		assert self._session_id is not None
		return {"threadUrn": post.thread_urn, **post_record(post), "sessionId": self._session_id}

	async def _validate_write_page(self, post_urn: str, prepared: dict[str, Any], what: str) -> None:
		"""The POST is made from the post's page, as LinkedIn's client makes
		it from the page the person is on (`_on_post_page`): the tab kept on the
		page prepare read from, or opened on it again where it has left — in the
		browser session prepare read in, holding the session cookie the request
		is signed with. Writes nothing: a browser that restarted, an attempt
		prepared by an older sidecar, or a page with no session, is
		PREPARED_UI_STALE before the journal holds the attempt as CLICKING — so
		is a page that will not open now, to try again."""
		await self._start()
		if self._session_id is None or prepared.get("sessionId") != self._session_id:
			raise SidecarError("PREPARED_UI_STALE", f"the browser restarted since the {what} was prepared")
		try:
			await self._on_post_page(post_urn, prepared.get("linkQuery"))
		except SidecarError as exc:
			raise SidecarError(
				"PREPARED_UI_STALE",
				f"the post's page could not be opened to send the {what} from ({exc.code}: {exc.message})",
				retryable=True,
			) from exc
		cookie = await self._evaluate_json(SESSION_COOKIE_JS)
		if not isinstance(cookie, dict) or cookie.get("ready") is not True:
			raise SidecarError("PREPARED_UI_STALE", f"the page holds no LinkedIn session to send the {what} in")

	async def validate_prepared_comment(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> None:
		await self._validate_write_page(input_value["postUrn"], prepared, "comment")

	async def _post_from_page(self, path: str, body: dict[str, Any]) -> Any:
		"""The one POST of `body` to `path`, from the page `_on_page` keeps, with
		the headers its own client names it by (`comment_write.PAGE_POST_JS`).
		Never repeated: what it answered — or that it did not — is the caller's
		to read."""
		headers = await self._page_identity(self._visit.opened_at) if self._visit is not None else {}
		answer = await self._evaluate_json(
			PAGE_POST_JS, path, wire_body(body), json.dumps(headers), NORMALIZED_JSON, COMMENT_SEND_TIMEOUT_MS
		)
		said = answer if isinstance(answer, dict) else {}
		print(
			f"[write] {urlparse(path).path.rsplit('/', 1)[-1]} from the {said.get('frame', '?')} window, "
			f"{len(headers)} page headers: HTTP {said.get('status')} (answer shape {answer_fingerprint(answer)})",
			file=sys.stderr,
			flush=True,
		)
		return answer

	async def commit_prepared_comment(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> str:
		"""POST the comment once, and read LinkedIn's answer to it.

		Called only once the journal holds the attempt as CLICKING; the account
		was probed and the page validated before that. The comment LinkedIn says
		it created on the post's thread, with these words, is the receipt
		(`comment_write.comment_outcome`); its stated refusal is WRITE_REFUSED,
		in its words. Anything else is uncertain, which a reading of LinkedIn's
		comment data for the post may still settle (`_settled_write`). The POST
		is never repeated."""
		posted_at = int(time.time() * 1000)
		answer = await self._post_from_page(
			CREATE_COMMENT_PATH, create_comment_body(text=input_value["text"], thread_urn=prepared["threadUrn"])
		)
		outcome = comment_outcome(
			answer,
			post_thread_urn=prepared["postThreadUrn"],
			post_names=prepared["postNames"],
			text=input_value["text"],
		)
		return await self._settled_write(
			outcome,
			refused="WRITE_REFUSED",
			read_back=lambda: self._comment_read_back(input_value["postUrn"], input_value["text"], posted_at),
		)

	async def _settled_write(
		self, outcome: dict[str, Any], *, refused: str, read_back: Callable[[], Awaitable[str | None]]
	) -> str:
		"""What a comment's or a reply's one POST came to: the urn of the
		comment LinkedIn said it created; `refused` with its words where it
		refused it; else LinkedIn's data read back, WRITE_READ_BACKS times at
		most, which can only find the comment — and, where it does not,
		WRITE_OUTCOME_UNCERTAIN with what LinkedIn answered. Nothing here
		POSTs."""
		if outcome["state"] == "confirmed":
			return str(outcome["commentUrn"])
		if outcome["state"] == "blocked":
			raise SidecarError(refused, outcome["detail"])
		for _ in range(WRITE_READ_BACKS):
			await asyncio.sleep(WRITE_READ_BACK_DELAY_S)
			try:
				found = await read_back()
			except (SidecarError, VoyagerUnavailable) as exc:
				print(f"[write] the read back did not answer: {exc}", file=sys.stderr, flush=True)
				found = None
			if found:
				print("[write] the uncertain write was found in LinkedIn's data", file=sys.stderr, flush=True)
				return found
		raise SidecarError(
			"WRITE_OUTCOME_UNCERTAIN", outcome["error"], rate_limited=outcome.get("rateLimited") is True
		)

	async def _comment_read_back(self, post_urn: str, text: str, posted_at: int) -> str | None:
		"""The urn of a comment of ours with these words on the post, written
		since `posted_at` — LinkedIn's clock beside this machine's allowed for
		(`READ_BACK_SKEW_MS`) — from LinkedIn's comment data. It can only FIND
		it: None is "not found yet", never "not posted"."""
		return (await self._read_own_comment(post_urn, text, since_ms=posted_at - READ_BACK_SKEW_MS)).urn

	async def _read_own_comment(self, post_urn: str, text: str, *, since_ms: int | None = None) -> OwnComment:
		"""What LinkedIn's comment data says of a comment of ours on the post —
		written since `since_ms`, where it is given: its urn, and whether the
		read was whole — or VoyagerUnavailable."""
		own = profile_identity(self._own_profile_url)
		if own is None:
			raise VoyagerUnavailable("the connected account is not known")
		return find_own_comment(
			await self._post_comment_pages(post_urn), own_profile_id=own[0], text=text, since_ms=since_ms
		)

	async def _post_comment_pages(self, post_urn: str) -> list[DataPage]:
		"""A post's comments from LinkedIn's comment data, read from the post's
		own page: newest first where LinkedIn answers that order, page by page
		while it counts comments the pages so far did not list, to
		POST_COMMENT_PAGES — or VoyagerUnavailable, for the page to answer."""
		route = f"{LINKEDIN_ORIGIN}/feed/update/"
		thread = self._thread_refs.get(post_urn)
		if thread is None:
			update = await self._voyager_get(
				f"/voyager/api/feed/updatesV2?q=backendUrnOrNss&urnOrNss={quote(post_urn, safe='')}&count=1",
				route_prefix=route,
			)
			thread = self._thread_refs[post_urn] = comment_thread_ref(update, post_urn)
		pages: list[DataPage] = []
		orders = (self._comment_order,) if self._comment_order else POST_COMMENT_ORDERS
		order = orders[0]
		for order in orders:
			try:
				first = await self._voyager_get(post_comments_address(thread, 0, order), route_prefix=route)
				pages = [post_comments_page(first)]
				self._comment_order = order
				break
			except VoyagerUnavailable:
				if order == orders[-1]:
					self._comment_order = None
					raise
		while wants_next_page(pages) and len(pages) < POST_COMMENT_PAGES:
			start = sum(len(page.comments) for page in pages)
			body = await self._voyager_get(post_comments_address(thread, start, order), route_prefix=route)
			pages.append(post_comments_page(body))
		return pages

	async def _find_own_comment(self, post_urn: str, text: str) -> str | None:
		if self._own_profile_url is None:
			return None
		rows = await self._evaluate_json(
			COMMENTS_JS, self._own_profile_url, " ".join(text.split()), post_urn
		)
		for row in rows:
			if (
				row.get("own")
				and row.get("postUrn") == post_urn
				and isinstance(row.get("commentUrn"), str)
			):
				return row["commentUrn"]
		return None

	async def _await_comment_list(self) -> int:
		"""Wait for the comment list to hydrate, and report how many rows appeared.

		`_goto` waits only for `readyState` plus a flat 0.6s, but LinkedIn hydrates
		the comment list separately. Reading straight after navigation returned
		ZERO comment nodes on one live run and ten on the next — same post, same
		code. A zero read makes reconciliation answer "not posted" about a comment
		that is live, which is the dangerous direction: `_resolve_write_outcome`
		treats a reconcile miss as its second guard before recording
		RESOLVED_NOT_POSTED, the one state that clears the post-click blockade.

		A post with genuinely no comments cannot be distinguished from one that has
		not hydrated, so this is a bounded wait, not a barrier: it returns 0 after
		the budget and the caller proceeds exactly as before.
		"""
		count = 0
		for attempt in range(COMMENT_HYDRATION_ATTEMPTS):
			count = int(await self._evaluate_json(COMMENT_COUNT_JS, COMMENT_ITEM_SELECTOR))
			if count:
				return count
			if attempt + 1 < COMMENT_HYDRATION_ATTEMPTS:
				await asyncio.sleep(COMMENT_HYDRATION_DELAY_S)
		return count

	async def reconcile_posted(self, input_value: dict[str, Any], since_ms: int | None = None) -> str | None:
		"""Whether the comment is on the post: its urn, or None from a whole read
		of LinkedIn's comment data only — a read that stops short of a comment
		LinkedIn counts raises, and so does a post whose comment data does not
		answer, the page's markup being able to find a comment and never to
		deny one. Where an attempt was sent (`since_ms`, when it was), only a
		comment written since — LinkedIn's clock allowed for — is its: the
		markup carries no time, so then only the data answers."""
		await self._assert_ready()
		if self._own_profile_url is None:
			await self.fetch_own_profile()
		await self._on_post_page(input_value["postUrn"])
		since = None if since_ms is None else since_ms - READ_BACK_SKEW_MS
		try:
			found = await self._read_own_comment(input_value["postUrn"], input_value["text"], since_ms=since)
		except VoyagerUnavailable as exc:
			print(f"[reconcile] the comment data did not answer ({exc}); reading the page", file=sys.stderr, flush=True)
		else:
			if found.urn or found.whole:
				return found.urn
			raise SidecarError(
				"THREAD_INCOMPLETE",
				"more comments stand under the post than one read returns, so none of them is known not to be ours",
				retryable=True,
			)
		urn = None if since is not None else await self._page_own_comment(input_value["postUrn"], input_value["text"])
		if urn:
			return urn
		raise SidecarError(
			"THREAD_UNAVAILABLE",
			"LinkedIn's comment data did not answer, and the page alone proves no comment is missing",
			retryable=True,
		)

	async def _page_own_comment(self, post_urn: str, text: str) -> str | None:
		"""The post's page, hydrated and its read-side controls pressed, read as
		markup for a comment of ours."""
		assert self._page is not None
		if not await self._await_comment_list():
			print(
				f"[reconcile] no comment rows rendered for {post_urn} "
				f"within {COMMENT_HYDRATION_ATTEMPTS * COMMENT_HYDRATION_DELAY_S:.0f}s",
				file=sys.stderr,
				flush=True,
			)
		# Expand only read-side comment controls.  No write control is selected here.
		for _ in range(3):
			clicked = await self._page.evaluate(LOAD_MORE_COMMENTS_JS)
			if clicked != "True":
				break
			await asyncio.sleep(0.5)
		return await self._find_own_comment(post_urn, text)

	async def _reply_post(self, input_value: dict[str, Any], link_query: str) -> PostThread:
		"""The post a reply goes under, opened by LinkedIn's own link at the
		comment (`_on_post_page`), its thread read from LinkedIn's data and open
		to comments (`_post_thread`)."""
		await self._assert_ready()
		await self._on_post_page(input_value["postUrn"], link_query, fresh=True)
		post = await self._post_thread(input_value["postUrn"])
		if not post.can_comment:
			raise SidecarError("COMMENTS_CLOSED", "LinkedIn does not let the account comment on the post")
		return post

	async def _replies_data(self, parent_urn: str, own_profile_id: str) -> dict[str, Any]:
		"""The replies under a comment, from LinkedIn's comment data alone — the
		one read whose evidence a reply's receipt is told from earlier ones by —
		or THREAD_UNAVAILABLE, to try again."""
		try:
			return await self._comment_data_replies(parent_urn, own_profile_id, None, REPLY_READ_LIMIT)
		except VoyagerUnavailable as exc:
			raise SidecarError(
				"THREAD_UNAVAILABLE", f"LinkedIn's comment data for the comment did not answer: {exc}", retryable=True
			) from exc

	async def prepare_reply(self, input_value: dict[str, Any]) -> dict[str, Any]:
		"""Everything short of the POST, and nothing that writes — the reply
		arm of a write.

		Opens the post at the reply it answers, as LinkedIn's own link to it
		does, and reads LinkedIn's data, never the page's markup: the post's
		thread, open to comments; our comment on it, still there and still ours
		— or, in a room's thread, the room comment our reply is under — and open
		to replies (`reply_parent`), whose urn as LinkedIn lists it is the
		thread the reply goes in (`comment_write.comment_thread`); and the reply
		being answered one of its replies, by someone else
		(`check_reply_target`). Returns the attempt's evidence for the journal:
		that thread, our replies already under the comment — which no receipt
		of this attempt may be — and the words the reply carries, exactly the
		owner's: no mention is added."""
		parent_urn, reply_to_urn = input_value["parentCommentUrn"], input_value["replyToUrn"]
		own = await self._own_profile_id()
		room_reply_urn = input_value.get("rootIsRoomReply", {}).get("replyUrn")
		link_query = reply_link_query(parent_urn, reply_to_urn) or comment_link_query(parent_urn)
		post = await self._reply_post(input_value, link_query)
		parent = reply_parent(
			await self._post_comment_pages_read(input_value["postUrn"]),
			parent_urn,
			own_profile_id=None if room_reply_urn else own,
		)
		thread = comment_thread(parent.urn, post)
		read = await self._replies_data(parent_urn, own)
		check_reply_target(read, reply_to_urn, room_reply_urn)
		assert self._session_id is not None
		return {
			"threadUrn": thread,
			**post_record(post),
			"linkQuery": link_query,
			"sessionId": self._session_id,
			"ownReplyUrns": own_reply_urns(read),
			"ownReplyUrnsFrom": "data",
			"body": clean(input_value["text"]),
		}

	async def _post_comment_pages_read(self, post_urn: str) -> list[DataPage]:
		"""`_post_comment_pages`, or THREAD_UNAVAILABLE, to try again."""
		try:
			return await self._post_comment_pages(post_urn)
		except VoyagerUnavailable as exc:
			raise SidecarError(
				"THREAD_UNAVAILABLE", f"LinkedIn's comment data for the post did not answer: {exc}", retryable=True
			) from exc

	async def prepare_room_reply(self, input_value: dict[str, Any]) -> dict[str, Any]:
		"""Everything short of the POST for a reply under a third party's
		comment, and nothing that writes: the post opened at the comment, its
		thread read and open to comments, and the comment itself — its author
		read from LinkedIn's comment data, never from a rendered name — still
		the selected member's and open to replies (`check_room_parent`). The
		evidence journaled is a reply's, beside the member the comment was
		bound to, its urn as LinkedIn lists it the thread the reply goes in."""
		parent_urn = input_value["parentCommentUrn"]
		own = await self._own_profile_id()
		link_query = comment_link_query(parent_urn)
		post = await self._reply_post(input_value, link_query)
		parent = check_room_parent(await self._post_comment_pages_read(input_value["postUrn"]), input_value, own)
		if parent.can_reply is False:
			raise SidecarError("COMMENTS_CLOSED", "LinkedIn does not let the account reply to the comment")
		thread = comment_thread(parent.urn, post)
		read = await self._replies_data(parent_urn, own)
		assert self._session_id is not None
		return {
			"threadUrn": thread,
			**post_record(post),
			"linkQuery": link_query,
			"sessionId": self._session_id,
			# A partial baseline cannot distinguish an earlier identical reply.
			"ownReplyUrns": own_reply_urns(read),
			"ownReplyUrnsFrom": "data",
			"body": clean(input_value["text"]),
			"parentAuthorMemberUrn": parent.member_urn,
		}

	async def validate_prepared_room_reply(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> None:
		own = await self._own_profile_id()
		check_room_parent(await self._post_comment_pages_read(input_value["postUrn"]), input_value, own)
		if prepared.get("parentAuthorMemberUrn") != input_value["expectedAuthorMemberUrn"]:
			raise SidecarError("ROOM_AUTHOR_CHANGED", "the prepared member binding changed")
		await self._validate_write_page(input_value["postUrn"], prepared, "room reply")

	async def commit_prepared_room_reply(self, input_value: dict[str, Any], expected_account_id: str,
		prepared: dict[str, Any]) -> str:
		"""POST the room reply once, as a reply's one POST (`commit_prepared_reply`);
		LinkedIn's stated refusal is ROOM_REPLY_REFUSED."""
		own = profile_identity(expected_account_id)
		if own is None or own[0] != input_value["expectedAccountProfileId"]:
			raise SidecarError("ACCOUNT_CHANGED", "the room reply account changed")
		return await self._post_reply(input_value, prepared, own[0], refused="ROOM_REPLY_REFUSED",
			found=lambda read: reconciled_room_reply(read, input_value, prepared))

	async def reconcile_room_reply(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> str | None:
		own = await self._own_profile_id()
		try:
			read = await self._comment_data_replies(input_value["parentCommentUrn"], own, None, REPLY_READ_LIMIT)
		except VoyagerUnavailable as exc:
			raise SidecarError("THREAD_UNAVAILABLE", "the room reply receipt data did not answer", retryable=True) from exc
		return reconciled_room_reply(read, input_value, prepared)

	async def validate_prepared_reply(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> None:
		"""The prepared reply's page and session, checked again before the
		token is spent — and a room's thread re-read for the reply it continues.
		Nothing is sent during this check."""
		if input_value.get("rootIsRoomReply"):
			await self._check_room_continuation(input_value, await self._own_profile_id())
		await self._validate_write_page(input_value["postUrn"], prepared, "reply")

	async def _check_room_continuation(self, input_value: dict[str, Any], own: str) -> None:
		try:
			read = await self._comment_data_replies(input_value["parentCommentUrn"], own, None, REPLY_READ_LIMIT)
		except VoyagerUnavailable as exc:
			raise SidecarError("THREAD_UNAVAILABLE", "the room conversation could not be verified", retryable=True) from exc
		check_reply_target(read, input_value["replyToUrn"], input_value["rootIsRoomReply"]["replyUrn"])

	async def commit_prepared_reply(
		self,
		input_value: dict[str, Any],
		expected_account_id: str,
		prepared: dict[str, Any],
	) -> str:
		"""POST the reply once, and read LinkedIn's answer to it. Called only
		once the journal holds the attempt as CLICKING; the account was probed
		again before that (`SidecarService._write`), and
		`expected_account_id` is the one it named. A room's thread is re-read
		for the reply it continues before the POST."""
		own = profile_identity(expected_account_id)
		if own is None:
			raise SidecarError("ACCOUNT_IDENTITY_UNAVAILABLE", "could not resolve the connected LinkedIn account")
		if input_value.get("rootIsRoomReply"):
			await self._check_room_continuation(input_value, own[0])
		return await self._post_reply(input_value, prepared, own[0], refused="WRITE_REFUSED",
			found=lambda read: own_reply(read, prepared))

	async def _post_reply(
		self,
		input_value: dict[str, Any],
		prepared: dict[str, Any],
		own_profile_id: str,
		*,
		refused: str,
		found: Callable[[dict[str, Any]], str | None],
	) -> str:
		"""A reply's one POST into the comment's thread: the reply LinkedIn says
		it created under it, on the post's thread, with these words, and none of
		the replies of ours already there, is the receipt; its stated refusal is
		`refused`; anything else is settled, where it can be, by LinkedIn's
		comment data for the comment read back (`_settled_write`) — `found`
		saying which reply of a read is this attempt's."""
		parent_urn = input_value["parentCommentUrn"]
		answer = await self._post_from_page(
			CREATE_COMMENT_PATH, create_comment_body(text=input_value["text"], thread_urn=prepared["threadUrn"])
		)
		outcome = comment_outcome(
			answer,
			post_thread_urn=prepared["postThreadUrn"],
			post_names=prepared["postNames"],
			text=input_value["text"],
			parent_urn=parent_urn,
			earlier=tuple(prepared["ownReplyUrns"]),
		)

		async def read_back() -> str | None:
			return found(await self._comment_data_replies(parent_urn, own_profile_id, None, REPLY_READ_LIMIT))

		return await self._settled_write(outcome, refused=refused, read_back=read_back)

	async def reconcile_reply(self, input_value: dict[str, Any], prepared: dict[str, Any]) -> str | None:
		"""Whether a prepared attempt's reply is under our comment: its urn, or
		None from a whole read of LinkedIn's comment data only. Where the
		attempt's evidence is the data's, the data names the reply and denies
		it. Where the page told it, the data only denies (`reply_denied`): a
		reply it lists could be an earlier identical one the page hid, so it is
		never adopted. A read that cannot finish raises, and the page's markup,
		which reads where the data does not settle it, can find the reply and
		never deny it — an absence is never inferred from a page."""
		own = await self._own_profile_id()
		parent_urn = input_value["parentCommentUrn"]
		self._comment_id_from_urn(parent_urn)
		try:
			read = await self._comment_data_replies(parent_urn, own, None, REPLY_READ_LIMIT)
		except VoyagerUnavailable as exc:
			print(f"[reconcile] the comment data did not answer ({exc}); reading the page", file=sys.stderr, flush=True)
		else:
			if prepared.get("ownReplyUrnsFrom") == "data":
				return reconciled_reply(read, prepared)
			if reply_denied(read, prepared):
				return None
		reading = await self._settled_thread(input_value["postUrn"], parent_urn)
		return reconciled_reply(self._reply_read(reading, own), prepared)

	@staticmethod
	def _reply_read(
		reading: ThreadReading, own_profile_id: str, threads: PageThreads | None = None
	) -> dict[str, Any]:
		return comment_replies(
			reading,
			own_profile_id=own_profile_id,
			since_ms=None,
			limit=REPLY_READ_LIMIT,
			observed_at=int(time.time() * 1000),
			threads=threads,
		)

	async def like_post(self, post_urn: str) -> str:
		"""Like the action target post with one POST of LinkedIn's own reaction
		request, or report that it is already liked.

		Returns "liked" or "already_liked". From the post's own page, LinkedIn's
		data says first how the account stands with it and what a like of it is
		keyed by (`_like_target`): liked is "already_liked", with nothing sent;
		another reaction is ALREADY_REACTED, never changed; a post the account
		may not react to is refused. Then one POST of a LIKE to the post's
		thread (`_send_like`). Whatever refuses before the POST is marked so
		(`not_attempted`): the like did not happen."""
		attempt = LikeAttempt("post")
		try:
			with pressed_nothing():
				await self._assert_ready()
				await self._on_post_page(post_urn)
				post = await self._post_thread(post_urn)
				reaction = post.reaction
				if reaction is None:
					attempt.result = "refused (no reaction read)"
					raise SidecarError(
						"LIKE_TARGET_UNREAD", "LinkedIn's data does not show how the account stands with the post"
					)
				if self._already_reacted(reaction):
					attempt.result = "already_liked (the data)"
					return "already_liked"
				if not post.can_react:
					attempt.result = "refused (no reactions)"
					raise SidecarError("REACTIONS_CLOSED", "LinkedIn does not let the account react to the post")
			return await self._send_like(post_urn, None, None, post.thread_urn, attempt)
		except SidecarError as exc:
			attempt.failed(exc)
			raise
		finally:
			attempt.log()

	async def like_comment(self, post_urn: str, comment_urn: str, parent_comment_urn: str | None = None) -> str:
		"""Like the action target COMMENT under its parent post, or report already
		liked, on the same contract as like_post. The post is opened by
		LinkedIn's own link to the comment — or, for a reply whose comment it
		answers is named (`parent_comment_urn`), to the reply — with it in view;
		a like of it is keyed by its own urn as LinkedIn's comment data lists it,
		on this post (`comment_write.comment_thread`); and how the account
		stands with it is read from the post's document and that data together
		(`_comment_listing`), a comment neither shows being refused."""
		attempt = LikeAttempt("reply" if parent_comment_urn else "comment")
		try:
			with pressed_nothing():
				await self._assert_ready()
				link_query = self._like_link_query(comment_urn, parent_comment_urn)
				visit = await self._on_post_page(post_urn, link_query, fresh=True)
				post = await self._post_thread(post_urn)
				listed_as, listed_reaction = await self._comment_listing(post_urn, comment_urn, parent_comment_urn)
				thread = comment_thread(listed_as or comment_urn, post)
				reaction = combined_reaction(self._kept_reaction(visit.document, post_urn, comment_urn), listed_reaction)
				if reaction is None:
					attempt.result = "refused (no reaction read)"
					raise SidecarError(
						"LIKE_TARGET_UNREAD", "LinkedIn's data does not show how the account stands with the comment"
					)
				if self._already_reacted(reaction):
					attempt.result = "already_liked (the data)"
					return "already_liked"
			return await self._send_like(post_urn, comment_urn, parent_comment_urn, thread, attempt)
		except SidecarError as exc:
			attempt.failed(exc)
			raise
		finally:
			attempt.log()

	async def _send_like(
		self,
		post_urn: str,
		comment_urn: str | None,
		parent_comment_urn: str | None,
		thread_urn: str,
		attempt: LikeAttempt,
	) -> str:
		"""The like's one POST to `thread_urn` (`comment_write.reaction_path`),
		from the page `_on_page` keeps — never repeated. LinkedIn's 2xx is its
		own success — the reaction API answers with an empty body — so it
		settles "liked" with its status for the receipt, no read after it to
		overrule it. LinkedIn's stated refusal is LIKE_REFUSED, in its words: it
		created nothing, so it is marked as a like that did not happen
		(`not_attempted`). Any other answer (a timeout, a 5xx, none) settles
		nothing and is read back (`_like_receipt`): the post's data showing the
		Like is then the only receipt."""
		answer = await self._post_from_page(reaction_path(thread_urn), REACTION_BODY)
		attempt.sent = "yes"
		outcome = reaction_outcome(answer)
		if outcome["state"] == "blocked":
			attempt.result = "refused by LinkedIn"
			raise SidecarError("LIKE_REFUSED", outcome["detail"], not_attempted=True)
		if outcome["state"] == "accepted":
			attempt.result = f"liked (HTTP {outcome['status']})"
			return "liked"
		print(f"[like] {outcome['error']}; reading the like back", file=sys.stderr, flush=True)
		return await self._like_receipt(post_urn, comment_urn, parent_comment_urn, attempt)

	async def _comment_listing(
		self, post_urn: str, comment_urn: str, parent_comment_urn: str | None
	) -> tuple[str | None, str | None]:
		"""How LinkedIn's comment data lists a comment or a reply — a reply
		among the replies under the comment it answers, a comment among the
		post's comments: the urn it spells it by, and the account's reaction its
		counts state (`data_reply_reaction`). Neither where it does not list it
		or does not answer: a source that does not answer says nothing."""
		try:
			pages = await (
				self._comment_data_pages(parent_comment_urn)
				if parent_comment_urn is not None
				else self._post_comment_pages(post_urn)
			)
		except (VoyagerUnavailable, SidecarError) as exc:
			print(f"[like] the comment data does not say: {exc}", file=sys.stderr, flush=True)
			return None, None
		wanted = comment_id(comment_urn)
		spelled = next((listed.urn for page in pages for listed in page.comments if comment_id(listed.urn) == wanted), None)
		return spelled, data_reply_reaction(pages, comment_urn)

	def _like_link_query(self, comment_urn: str | None, parent_comment_urn: str | None) -> str | None:
		"""The query LinkedIn's own link to a like's target opens the post with:
		a reply's, where the comment it answers is named; a comment's; none for
		the post."""
		if comment_urn is None:
			return None
		return self._reply_link_query(comment_urn, parent_comment_urn) or comment_link_query(comment_urn)

	async def read_like_state(
		self, post_urn: str, comment_urn: str | None, parent_comment_urn: str | None = None
	) -> dict[str, Any]:
		"""The account's reaction to the post, or to a comment or reply under it,
		from the post's document — `Like`, `Default` (none), another reaction's
		name, or null where the data cannot tell — and which account was signed
		in. A reply is read from the post opened by LinkedIn's own link to it,
		which needs the comment it answers (`parent_comment_urn`), and from
		LinkedIn's comment data beside it (`_reply_reaction`); without the
		comment, or where the link cannot be formed, the post is opened as it was
		and a reply the document does not declare is read from the comment data
		alone, which needs the comment too — so null. Read only: nothing is
		pressed, and a null is never "not liked"."""
		await self._assert_ready()
		link_query = self._reply_link_query(comment_urn, parent_comment_urn)
		document = await self._open_post_keeping_document(post_urn, link_query)
		# Whose reaction this is: the account signed in as it was read, probed
		# without leaving the page. Another account's `Default` is nothing to
		# settle a like by, so the caller compares it with the one it expects.
		account = profile_identity(await self.connected_account_id(preserve_page=True))
		if account is None:
			raise SidecarError(
				"ACCOUNT_IDENTITY_UNAVAILABLE", "could not resolve the connected LinkedIn account", retryable=True
			)
		reaction = self._kept_reaction(document, post_urn, comment_urn)
		if link_query is not None and reaction != LIKE:
			reaction = combined_reaction(reaction, await self._reply_reaction(parent_comment_urn, comment_urn))
		return {
			"reaction": reaction,
			"observedAt": int(time.time() * 1000),
			"accountId": account[0],
		}

	@staticmethod
	def _already_reacted(reaction: str | None) -> bool:
		"""Whether LinkedIn's data, before the POST, shows the account's Like
		already; ALREADY_REACTED where it shows another reaction, which a Like
		would change. Data that cannot tell is no Like."""
		if reaction is None or reaction == NO_REACTION:
			return False
		if reaction == LIKE:
			return True
		raise SidecarError("ALREADY_REACTED", f"the account already reacted to the action target ({reaction})", not_attempted=True)

	async def _like_receipt(
		self, post_urn: str, comment_urn: str | None, parent_comment_urn: str | None, attempt: LikeAttempt
	) -> str:
		"""The receipt for a sent Like whose POST answer settled nothing: the
		post opened afresh at the action target, its document — and, for a post, its
		counts, for a comment or a reply, LinkedIn's comment data — showing the
		account's Like, either one enough. Anything else, by the last read, is
		LIKE_UNCONFIRMED — the POST went out, so it is never "not liked" here;
		the core's reconcile reads it again."""
		link_query = self._like_link_query(comment_urn, parent_comment_urn)
		reaction: str | None = None
		for _ in range(LIKE_RECEIPT_READS):
			await asyncio.sleep(LIKE_RECEIPT_DELAY_S)
			document = await self._open_post_keeping_document(post_urn, link_query)
			if comment_urn is None:
				reaction = combined_reaction(
					self._kept_reaction(document, post_urn, None), await self._post_reaction(post_urn)
				)
			else:
				_, listed_reaction = await self._comment_listing(post_urn, comment_urn, parent_comment_urn)
				reaction = combined_reaction(self._kept_reaction(document, post_urn, comment_urn), listed_reaction)
			if reaction == LIKE:
				attempt.result = "liked"
				return "liked"
		attempt.result = f"unconfirmed (read back {reaction or 'nothing'})"
		raise SidecarError(
			"LIKE_UNCONFIRMED",
			"the Like was sent but the post's data never showed it",
			retryable=True,
		)

	async def _post_reaction(self, post_urn: str) -> str | None:
		"""The account's reaction to the post as its counts state it, or None
		where LinkedIn's data does not answer."""
		try:
			return (await self._post_thread(post_urn)).reaction
		except SidecarError as exc:
			print(f"[like] the post's counts do not say: {exc}", file=sys.stderr, flush=True)
			return None

	async def _reply_reaction(self, parent_comment_urn: str, reply_urn: str) -> str | None:
		"""The account's reaction to a reply as LinkedIn's comment data states it
		(`comment_data.py`), the second source beside the post's document. A
		source that does not answer is no source: None, never "not liked"."""
		try:
			return data_reply_reaction(await self._comment_data_pages(parent_comment_urn), reply_urn)
		except (VoyagerUnavailable, SidecarError) as exc:
			print(f"[like] the comment data does not say: {exc}", file=sys.stderr, flush=True)
			return None

	@staticmethod
	def _reply_link_query(comment_urn: str | None, parent_comment_urn: str | None) -> str | None:
		"""The query that opens the post at a reply, where there is a reply, a
		comment it answers, and a link LinkedIn's own shape allows for them."""
		if comment_urn is None or parent_comment_urn is None:
			return None
		query = reply_link_query(parent_comment_urn, comment_urn)
		if query is None:
			print("[like] no link to the reply can be formed; the post is read as it opens", file=sys.stderr, flush=True)
		return query

	@staticmethod
	def _kept_reaction(document: str | None, post_urn: str, comment_urn: str | None) -> str | None:
		"""The account's reaction to the action target in a kept document, or None
		where the document was not kept or does not say (`like_data.py`)."""
		if document is None:
			print("[like] the post's document was not kept", file=sys.stderr, flush=True)
			return None
		try:
			return document_reaction(document, post_urn=post_urn, comment_urn=comment_urn)
		except Unrecognised as exc:
			print(f"[like] the post's data does not say: {exc}", file=sys.stderr, flush=True)
			return None

	@staticmethod
	def _process_alive(pid: int) -> bool:
		"""Whether that pid is still a live process. Signal 0 delivers nothing;
		it only asks the kernel whether the process exists and is ours."""
		try:
			os.kill(pid, 0)
		except ProcessLookupError:
			return False
		except PermissionError:  # alive, and not ours to signal
			return True
		except OSError:  # a platform without signal 0 — assume it is still there
			return True
		return True

	async def _await_browser_exit(self, pid: int | None, deadline: float) -> bool:
		"""Wait for the launched browser process to leave the process table."""
		if pid is None:
			return False
		while time.monotonic() < deadline:
			if not self._process_alive(pid):
				return True
			await asyncio.sleep(0.1)
		return not self._process_alive(pid)

	def _profile_lock_holder(self) -> int | None:
		"""The live Chromium holding this profile's user-data-dir lock, or None.

		Chromium's `SingletonLock` is a symlink to `<hostname>-<pid>`. The hostname
		decides nothing: a Mac's changes with its network, so a browser left over
		from before the change names a host that is no longer this one. The pid
		does — a dead one is a stale lock Chromium clears itself, and a live pid
		whose command line is not Chromium on THIS profile is a reused number.
		Neither is a holder, and the last must never be signalled.
		"""
		try:
			target = os.readlink(self._profile_dir / "SingletonLock")
		except OSError:
			return None
		_, _, pid_text = target.rpartition("-")
		if not pid_text.isdigit():
			return None
		pid = int(pid_text)
		if not self._process_alive(pid):
			return None
		try:
			command = subprocess.run(
				["ps", "-ww", "-o", "command=", "-p", str(pid)],
				check=True,
				capture_output=True,
				text=True,
				timeout=5,
			).stdout
		except (OSError, subprocess.SubprocessError):
			return None
		return pid if f"--user-data-dir={self._profile_dir}" in command else None

	async def _reap_orphaned_browser(self) -> None:
		"""Close a Chromium an earlier sidecar left holding this profile.

		A sidecar killed mid-close, or one that crashed, leaves its Chromium
		running and holding the user-data-dir lock. A launch on that profile is
		then handed to the orphan, which opens one more empty window, and Browser
		Use waits for a debugger that never comes: 30s of `BrowserStartEvent` per
		attempt and a blank window per retry (measured 2026-10-22: eleven in 45
		minutes after a sleep/wake).

		Any holder IS an orphan: this process holds the journal flock, and only a
		sidecar holding it launches on this profile. SIGTERM is Chromium's own
		graceful exit on POSIX, so cookies it holds only in memory still flush.
		"""
		pid = self._profile_lock_holder()
		if pid is None:
			return
		print(f"[browser-use] closing orphaned Chromium {pid} that holds the profile", file=sys.stderr, flush=True)
		try:
			os.kill(pid, signal.SIGTERM)
			if await self._await_browser_exit(pid, time.monotonic() + BROWSER_CLOSE_TIMEOUT_S):
				return
			os.kill(pid, signal.SIGKILL)
		except ProcessLookupError:
			return
		if not await self._await_browser_exit(pid, time.monotonic() + BROWSER_CLOSE_REQUEST_TIMEOUT_S):
			print(f"[browser-use] orphaned Chromium {pid} is still running after SIGKILL", file=sys.stderr, flush=True)

	async def _request_browser_close(self, deadline: float) -> bool:
		"""Ask Chromium to close ITSELF over CDP. Whether it obeys is answered by
		the process wait, not by this reply."""
		client = getattr(self._browser, "cdp_client", None)
		if client is None:
			return False
		try:
			await asyncio.wait_for(
				client.send_raw("Browser.close", {}),
				timeout=min(BROWSER_CLOSE_REQUEST_TIMEOUT_S, max(0.1, deadline - time.monotonic())),
			)
		except Exception as exc:  # noqa: BLE001 — the dropped socket IS the close
			print(f"[browser-use] Browser.close returned no reply: {exc}", file=sys.stderr, flush=True)
		return True

	async def _close_local_browser(self) -> None:
		"""Close the Chromium we launched, and DO NOT RETURN UNTIL IT IS GONE.

		INVARIANT: the sidecar outlives the browser it owns. Chromium persists
		cookies through a batching commit timer, so an authenticated `li_at`
		set seconds before teardown exists only in memory; a process-group
		SIGTERM takes Chromium with the sidecar and that sign-in is lost.
		Measured on a blank free install (2026-09-15): a probe answered
		`live, Slava Nikitin` at 11:25:36, the session ended within a second,
		and the profile's cookie store held `JSESSIONID`/`bcookie`/`lidc` and no
		`li_at` at all — the next session read `login_required`. `Browser.close`
		runs Chromium's own shutdown path, which flushes the store; WAITING for
		the exit is what makes the flush a fact rather than a request.

		A `terminate()` cannot do this job: it is a signal, not a shutdown, and
		one nobody waits for. It is only the fallback below.
		"""
		self._closed_gracefully = False
		deadline = time.monotonic() + BROWSER_SHUTDOWN_BUDGET_S
		pid = self._browser_pid
		polite = min(time.monotonic() + BROWSER_CLOSE_TIMEOUT_S, deadline)
		if await self._request_browser_close(deadline) and await self._await_browser_exit(pid, polite):
			self._closed_gracefully = True
			return
		# Chromium did not take the polite close — a wedged renderer, or no CDP
		# client left to ask. Fall back to the forced stop, which
		# terminates and then kills, and wait on that too. Bounded by the same
		# deadline: `kill()` has waits of its own, and a shutdown that outruns
		# the budget is one the node client is about to signal anyway.
		print("[browser-use] browser did not close on request; forcing", file=sys.stderr, flush=True)
		try:
			await asyncio.wait_for(self._browser.kill(), timeout=max(0.5, deadline - time.monotonic()))
		except Exception as exc:  # noqa: BLE001 — the exit below is the verdict
			print(f"[browser-use] forced stop reported: {exc}", file=sys.stderr, flush=True)
		if not await self._await_browser_exit(pid, deadline):
			print(
				f"[browser-use] browser process {pid} is still running after a forced stop",
				file=sys.stderr,
				flush=True,
			)

	async def restart_browser(self, *, place: Mapping[str, int] | None = None) -> dict[str, Any]:
		"""Close Engager's browser and start it again on the same profile: the
		sign-in step's Try again (US-ONF-07), for a browser the probe can no longer
		reach.

		The close is `shutdown`'s, which does not return until the browser has
		exited, so the cookies it held only in memory reach the profile before the
		next launch reads it. The start is `_start`'s, which first closes any
		Chromium an earlier sidecar left holding the profile
		(`_reap_orphaned_browser`); with no browser of ours to close, that reap is
		the whole of the close. The profile is the one in use: it is never
		archived, renamed or emptied, so the owner's sign-in survives.

		Only the browser restarts: no page is opened, navigated or typed into,
		and the window comes up where a reveal puts it (`place`). The look that
		follows is the caller's.

		A cloud browser is a session we do not own, replaced by its holder
		(`bridgeServer.relinkHostedBrowser`), never from here.
		"""
		if self._cdp_url:
			raise SidecarError("INVALID_REQUEST", "a cloud browser is replaced by its holder, not restarted here")
		await self.shutdown()
		return await self.set_window_visibility(None, reveal=True, place=place)

	async def shutdown(self) -> None:
		if self._browser is None:
			return
		try:
			if self._cdp_url:
				# A CDP attach is a browser we do not own: detach, never stop it.
				await self._browser.detach()
			else:
				await self._close_local_browser()
				await self._browser.detach()
		except Exception as exc:  # noqa: BLE001 — a group SIGTERM may have taken
			# Chrome first; a browser that is already gone IS shut down.
			print(f"[browser-use] browser stop reported: {exc}", file=sys.stderr, flush=True)
		finally:
			self._browser = None
			self._page = None
			self._browser_pid = None

	# The test cookie the Browser check's round trip writes and reads back.
	# Never a LinkedIn name: the host is a reserved `.test` one nothing serves.
	_CHECK_COOKIE_NAME = "engager_keychain_check"
	_CHECK_COOKIE_URL = "https://keychain-check.engager.test/"
	_CHECK_COOKIE_TTL_S = 3600

	async def _check_page_cdp(self) -> tuple[Any, str]:
		"""The CDP client and the blank page's session id, where the check's
		cookie is written and read (Network.* belongs to a page's session)."""
		assert self._browser is not None and self._page is not None
		session = await self._browser.session_for(self._page.target_id)
		return session.cdp_client, session.session_id

	async def _write_check_cookie(self, value: str) -> None:
		client, session_id = await self._check_page_cdp()
		written = await client.send.Network.setCookie(
			params={
				"name": self._CHECK_COOKIE_NAME,
				"value": value,
				"url": self._CHECK_COOKIE_URL,
				"secure": True,
				# Persistent, so it is written to the profile's cookie store at all.
				"expires": time.time() + self._CHECK_COOKIE_TTL_S,
			},
			session_id=session_id,
		)
		# A refusal CDP reports in the reply, not as an error: nothing was set,
		# which says nothing about the keychain.
		if not written.get("success"):
			raise RuntimeError("the browser refused the test cookie")

	async def _read_check_cookie(self) -> str | None:
		client, session_id = await self._check_page_cdp()
		read = await client.send.Network.getCookies(params={"urls": [self._CHECK_COOKIE_URL]}, session_id=session_id)
		for cookie in read.get("cookies", []):
			if cookie.get("name") == self._CHECK_COOKIE_NAME:
				return str(cookie.get("value", ""))
		return None

	async def self_check(self) -> dict[str, str]:
		"""Prove Engager's own browser starts and keeps a sign-in: start it,
		read its version over CDP, save a test cookie, close it, start it again
		on the same profile and read the cookie back (US-OND-05, US-OND-09).

		The sidecar's own start path (`_start`), so what is checked is what
		LinkedIn work will launch -- the pinned executable, the
		same flags -- with the three things that would touch the owner turned
		off: the profile is the caller's throwaway `--profile-dir`, the browser
		is headless so no window ever opens, and the hide step never runs, so
		the Automation (System Events) prompt it needs is never asked for.
		Nothing is navigated: the page is the browser's own blank one, and the
		LinkedIn-only tab guard would send anything else back to it.

		The round trip is what the cookie key is for. Chromium encrypts its
		cookie store with a key held in the login keychain ("Chromium Safe
		Storage"); when macOS refuses the browser that key, it cannot write the
		cookie, and a LinkedIn sign-in would be gone at the next restart. The
		first start asks macOS for the key, which is where the owner's dialog
		appears. The close is `_close_local_browser`'s -- it waits for the
		process to exit, which is what flushes the store -- so a cookie missing
		after a restart that followed a graceful close is the key's absence,
		not a race. A close that had to be forced flushes nothing, and says
		nothing about the key: that is `BROWSER_UNAVAILABLE`, not a verdict.

		Returns the product and version the browser reported. A browser that
		will not start, will not take the cookie or will not close on request
		raises `BROWSER_NOT_INSTALLED` (no pinned file) or
		`BROWSER_UNAVAILABLE`; one that closed cleanly and still did not keep
		the cookie raises `KEYCHAIN_REFUSED`. Either way the browser is closed
		again.
		"""
		self._headless = True
		self._hidden = False
		self._hidden_by_choice = lambda: False  # type: ignore[method-assign]
		value = uuid.uuid4().hex
		await self._start()
		try:
			reported = await self._browser.cdp_client.send.Browser.getVersion()  # type: ignore[union-attr]
			product = str(reported.get("product", ""))
			await self._write_check_cookie(value)
		except Exception as exc:  # noqa: BLE001 — a browser that cannot answer did not start
			raise SidecarError("BROWSER_UNAVAILABLE", f"the browser did not answer: {exc}", retryable=True) from exc
		finally:
			await self.shutdown()
		if not self._closed_gracefully:
			raise SidecarError("BROWSER_UNAVAILABLE", "the browser did not close cleanly", retryable=True)
		await self._start()
		try:
			kept = await self._read_check_cookie()
		except Exception as exc:  # noqa: BLE001 — as above
			raise SidecarError("BROWSER_UNAVAILABLE", f"the browser did not answer: {exc}", retryable=True) from exc
		finally:
			await self.shutdown()
		if kept != value:
			raise SidecarError(
				"KEYCHAIN_REFUSED",
				"the browser did not keep a cookie across a restart: macOS did not give it its keychain key",
			)
		name, _, version = product.partition("/")
		return {"product": name, "version": version}

	@property
	def selector_pack_version(self) -> str:
		return SELECTOR_PACK_VERSION
