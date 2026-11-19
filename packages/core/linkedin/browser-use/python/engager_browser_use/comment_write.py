"""Comments, replies and likes, written as LinkedIn's own client writes them.

LinkedIn's client creates a comment with one POST of its words and the thread
it answers to its comments API (`comments/utils/comment-requests`'s
`createComment`, read from its bundle 2026-10-21): `voyagerSocialDashNormComments`,
its recipe `NormComment` expanded to the decoration the client's recipe map
names, the body `{commentary, threadUrn}` — the words a TextViewModel, the
thread `socialDetail.threadUrn` of what is answered. A reply is the same
request with the comment's own thread. It likes a post or a comment with one
POST of the reaction to its reactions API (`feed-requests/reactions`'s
`createDashReactionRequest`): `voyagerSocialDashReactions?threadUrn=<thread>`,
the body `{reactionType}`, the thread `totalSocialActivityCounts.urn`. The
sidecar makes that one request from the page a person would be on — the
post's — in the page's session, beside its CSRF token and the headers its own
client names it by (`page_visit.py`), through the window LinkedIn's API client
runs in (`PAGE_POST_JS`). Nothing is typed, focused or pressed: no composer,
no Reply and no Like control is ever touched.

What a comment, a reply or a like ever touches, and nothing else:

- the post's own page, opened as a person opens it — at the comment, where
  the write answers or likes one — and LinkedIn's data for the post read from
  it (`post_thread`); for a reply or a comment's like, LinkedIn's comment data
  for the post or for the comment it answers (`comment_data.py`);
- one POST, carrying exactly the owner's words, unformatted and with no
  mention: `create_comment_body` to `CREATE_COMMENT_PATH` once the journal
  holds the attempt as CLICKING, or `REACTION_BODY` to `reaction_path`.

THE THREAD IS LINKEDIN'S WORD, never built. A post's is what LinkedIn's data
for the post, asked by the urn the owner approved, says it is
(`post_thread`): the update it answers with is that post — the approved urn,
or the content the approved activity carries (`shareUrn`) — and its
socialDetail's `urn`, the client's `threadUrn` (the dash socialDetail's first
key) and its counts' `urn` must all name one thread, the approved post or
LinkedIn's own mapping of it (read live 2026-10-21: an activity whose comments
and reactions are keyed by the ugcPost it carries). A comment's thread is its
own urn as LinkedIn's comment data lists it, on this post (`comment_thread`).
Anything else is refused before anything is sent.

A comment takes the viewer's `canPostComments` and a like `canReact`, as the
client reads them, and a post whose commenting is disabled takes no comment.

What a write came to is LinkedIn's answer to that POST (`comment_outcome`,
`reaction_outcome`): for a comment or a reply, the comment it created, on this
thread, with these words, is the receipt; a refusal it states is the write
refused, in its words; anything else — no answer, a timeout, a server error,
an answer this module does not read — settles nothing, and only a read of the
thread does. A like has no such body to read: the reaction API answers a
success with an empty 2xx, which is the like's receipt; a read of the post's
data settles only the like whose answer settled nothing.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlencode

from .comment_data import stated_reaction
from .dm_write import stated_reason
from .protocol import SidecarError
from .replies import clean, comment_id, text_hash

# Where LinkedIn's client POSTs a comment or a reply: the comments resource,
# its `NormComment` recipe expanded to the decoration the client's recipe map
# names for it.
CREATE_COMMENT_PATH = (
	"/voyager/api/voyagerSocialDashNormComments?decorationId=com.linkedin.voyager.dash.deco.social.NormComment-44"
)
# Where it POSTs a reaction; the thread rides in the query.
REACTION_PATH = "/voyager/api/voyagerSocialDashReactions"
# The one reaction Engager makes.
REACTION_BODY: dict[str, Any] = {"reactionType": "LIKE"}
# What the client's data layer asks LinkedIn's API to answer in.
NORMALIZED_JSON = "application/vnd.linkedin.normalized+json+2.1"
# The words' type, as the client's model builder stamps them.
TEXT_VIEW_MODEL = "com.linkedin.voyager.dash.common.text.TextViewModel"
# How long the one POST waits for LinkedIn's answer before it is uncertain.
SEND_TIMEOUT_MS = 20_000
# LinkedIn's statuses that refuse nothing: a request it timed out on, one in
# conflict with another, one too early or too many. Every other 4xx refuses
# the write, and nothing was created.
_UNSETTLED_STATUSES = frozenset({408, 409, 425, 429})

_POST_URN_RE = re.compile(r"urn:li:(?:activity|ugcPost|share):\d+")
# A comment's urn as LinkedIn keys it: its post's thread, then its own id.
_COMMENT_URN_RE = re.compile(r"urn:li:comment:\(((?:activity|ugcPost|share):\d+),(\d+)\)")
# The dash spelling of the same comment: its id, then its post's thread.
_DASH_COMMENT_URN_RE = re.compile(r"urn:li:fsd_comment:\((\d+),urn:li:((?:activity|ugcPost|share):\d+)\)")
_NORM_PREFIX = "urn:li:fsd_normComment:"

# The one POST, as LinkedIn's API client makes it: an XMLHttpRequest from the
# window that client runs in — the `/preload/` frame a redesigned page hosts
# it in, else the page itself — so it passes through whatever that window's
# own client wraps its requests in; the body as a string, the page's own
# headers beside the CSRF token from the session cookie. An answer that never
# comes is status 0 with what stopped it. Never retried here.
PAGE_POST_JS = r"""(path, body, pageHeaders, accept, timeoutMs) => new Promise(resolve => {
  const windows = [...document.querySelectorAll('iframe')].map(frame => {
    try { return frame.contentWindow && frame.contentWindow.location.pathname === '/preload/' ? frame.contentWindow : null; }
    catch (e) { return null; }
  });
  const client = windows.find(Boolean) || window;
  const frame = client === window ? 'page' : 'preload';
  const jsession = (document.cookie.match(/JSESSIONID="?([^";]+)"?/) || [])[1] || '';
  const xhr = new client.XMLHttpRequest();
  let answered = false;
  const answer = value => { if (!answered) { answered = true; resolve(JSON.stringify({frame, ...value})); } };
  try {
    xhr.open('POST', path, true);
    xhr.timeout = timeoutMs;
    const headers = {
      ...JSON.parse(pageHeaders),
      'csrf-token': jsession,
      'accept': accept,
      'content-type': 'application/json; charset=UTF-8',
      'x-restli-protocol-version': '2.0.0',
    };
    for (const name of Object.keys(headers)) xhr.setRequestHeader(name, headers[name]);
    xhr.onload = () => answer({status: xhr.status, body: xhr.responseText});
    xhr.ontimeout = () => answer({status: xhr.status, error: 'timed out'});
    xhr.onerror = () => answer({status: xhr.status, error: 'the request failed'});
    xhr.onabort = () => answer({status: xhr.status, error: 'the request was aborted'});
    xhr.send(body);
  } catch (e) {
    answer({status: xhr.status || 0, error: String(e)});
  }
})"""


@dataclass(frozen=True)
class PostThread:
	"""What LinkedIn's data for one post says a write on it needs: the thread
	its comments and reactions are keyed by, every urn LinkedIn's data names
	the post by — the approved one, the activity it is shown as, the content
	it carries, the thread — whether the account may comment and react there,
	and the account's reaction as the post's counts state it
	(`stated_reaction`: `Like`, `Default`, another's name, or None)."""

	thread_urn: str
	names: frozenset[str]
	can_comment: bool
	can_react: bool
	reaction: str | None


def post_thread(payload: Any, post_urn: str) -> PostThread:
	"""The thread of the post the owner approved, from LinkedIn's data for
	it asked by that urn (`feed/updatesV2?q=backendUrnOrNss`), and what the
	account may do on it — or a SidecarError, before anything is sent:
	THREAD_UNAVAILABLE for no post, THREAD_MISMATCH for data that names
	another, UI_DRIFT for data this does not read."""
	if not _POST_URN_RE.fullmatch(post_urn):
		raise SidecarError("INVALID_REQUEST", "postUrn is not a LinkedIn activity, ugcPost or share urn")
	index = _index(payload)
	update = _first_update(payload, index)
	if update is None:
		raise SidecarError("THREAD_UNAVAILABLE", "LinkedIn's data holds no post for this urn")
	metadata = update.get("updateMetadata") if isinstance(update.get("updateMetadata"), dict) else {}
	shown, carried = metadata.get("urn"), metadata.get("shareUrn")
	if post_urn not in (shown, carried):
		raise SidecarError("THREAD_MISMATCH", "LinkedIn's data for the post names another post than the one approved")
	social = _entity(index, update.get("*socialDetail"), ".SocialDetail")
	thread = social.get("urn") if social else None
	if not isinstance(thread, str) or not _POST_URN_RE.fullmatch(thread):
		raise SidecarError("UI_DRIFT", "LinkedIn's data for the post names no thread this reads")
	assert social is not None
	if thread not in (post_urn, shown, carried):
		raise SidecarError("THREAD_MISMATCH", "the post's comments are keyed by a thread that is not this post")
	dash = social.get("dashEntityUrn")
	counts = _entity(index, social.get("*totalSocialActivityCounts"), ".SocialActivityCounts")
	if (
		not isinstance(dash, str)
		or not dash.startswith(f"urn:li:fsd_socialDetail:({thread},")
		or counts is None
		or counts.get("urn") != thread
	):
		raise SidecarError("THREAD_MISMATCH", "LinkedIn's data names the post's thread two ways")
	permissions = _entity(index, social.get("*socialPermissions"), ".SocialPermissions")
	can_comment = permissions.get("canPostComments") if permissions else None
	can_react = permissions.get("canReact") if permissions else None
	if not isinstance(can_comment, bool) or not isinstance(can_react, bool):
		raise SidecarError("UI_DRIFT", "LinkedIn's data does not say what the account may do on the post")
	return PostThread(
		thread_urn=thread,
		names=frozenset(name for name in (post_urn, shown, carried, thread) if isinstance(name, str)),
		can_comment=can_comment and social.get("commentingDisabled") is not True,
		can_react=can_react,
		reaction=stated_reaction(counts),
	)


def post_record(post: PostThread) -> dict[str, Any]:
	"""What an attempt's journal keeps of the post it writes on, for commit to
	read LinkedIn's answer against (`comment_outcome`)."""
	return {"postThreadUrn": post.thread_urn, "postNames": sorted(post.names)}


def comment_thread(comment_urn: str, post: PostThread) -> str:
	"""The thread a reply under `comment_urn` goes in, and a like of it is
	keyed by: the comment's own urn, as LinkedIn spells it — the caller passes
	the spelling LinkedIn's comment data lists it by, where it lists it —
	refused unless it is a comment on this post, by one of the names
	LinkedIn's data gives the post."""
	match = _COMMENT_URN_RE.fullmatch(comment_urn)
	if match is None:
		raise SidecarError("INVALID_REQUEST", "the comment is not a LinkedIn comment urn")
	if f"urn:li:{match.group(1)}" not in post.names:
		raise SidecarError("THREAD_MISMATCH", "the comment is not on the post the write is for")
	return comment_urn


def comment_link_query(comment_urn: str) -> str:
	"""The query of LinkedIn's own link to a comment (its `permalink`), which
	opens the post with the comment in view."""
	return urlencode({"commentUrn": comment_urn}, quote_via=quote)


def create_comment_body(*, text: str, thread_urn: str) -> dict[str, Any]:
	"""What the POST carries, as LinkedIn's client builds it: the owner's
	words exactly, with no attribute — no mention, no link, no formatting —
	into `thread_urn`."""
	return {"commentary": {"text": text, "attributesV2": [], "$type": TEXT_VIEW_MODEL}, "threadUrn": thread_urn}


def reaction_path(thread_urn: str) -> str:
	"""Where a reaction to `thread_urn` is POSTed: the thread encoded as the
	client's restli encoder writes a query value."""
	return f"{REACTION_PATH}?threadUrn={quote(thread_urn, safe='')}"


def comment_outcome(
	answer: Any,
	*,
	post_thread_urn: str,
	post_names: Iterable[str],
	text: str,
	parent_urn: str | None = None,
	earlier: tuple[str, ...] = (),
) -> dict[str, Any]:
	"""What LinkedIn's answer to a comment's or a reply's one POST says, as
	PAGE_POST_JS handed it over: `confirmed` with the comment it created
	(`created_comment`); `blocked` with its stated refusal — a 4xx, nothing
	created; `uncertain`, with what was seen, for anything else. Every one
	keeps a plain detail."""
	status = answer.get("status") if isinstance(answer, dict) else None
	if not isinstance(status, int) or isinstance(status, bool):
		return {"state": "uncertain", "error": "the page handed back no answer to the comment's request"}
	if status == 0:
		failed = answer.get("error") or "no status"
		return {"state": "uncertain", "error": f"LinkedIn did not answer the comment's request: {failed}"}
	if 200 <= status < 300:
		created = created_comment(
			answer.get("body"),
			post_thread_urn=post_thread_urn,
			post_names=post_names,
			text=text,
			parent_urn=parent_urn,
			earlier=earlier,
		)
		if isinstance(created, str):
			return {"state": "uncertain", "error": f"LinkedIn answered HTTP {status}, but {created}"}
		return {"state": "confirmed", **created}
	return _refusal_or_unsettled(answer, status, "the comment")


def created_comment(
	body: Any,
	*,
	post_thread_urn: str,
	post_names: Iterable[str],
	text: str,
	parent_urn: str | None = None,
	earlier: tuple[str, ...] = (),
) -> dict[str, str] | str:
	"""The comment a 2xx answer says LinkedIn created — `commentUrn`, its urn
	as LinkedIn keys it, `urn:li:comment:(<the post>,<its id>)`, the post
	spelled as its thread where the answer spells it so — or, as a clause, why
	the answer is not one. The answer must name exactly one comment with these
	words on this post, by any of its names, read off any entity it holds by
	its urn in either spelling; one that is the comment a reply goes under, or
	an earlier reply of ours, is not it."""
	try:
		parsed = json.loads(body) if isinstance(body, str) else None
	except json.JSONDecodeError:
		parsed = None
	entities = _entities(parsed)
	if not entities:
		return "its answer is not the comment LinkedIn's client reads"
	wanted = text_hash(clean(text))
	posts = {name.removeprefix("urn:li:") for name in post_names}
	excluded = {comment_id(urn) for urn in (parent_urn, *earlier) if urn}
	found: set[tuple[str, str]] = set()
	for entity in entities:
		words = _words(entity)
		if words is None or text_hash(clean(words)) != wanted:
			continue
		found.update(_named_comments(entity))
	ours = {(on, own_id) for on, own_id in found if on in posts and own_id not in excluded}
	if not found:
		return "its answer names no comment with the comment's words"
	if len({own_id for _, own_id in ours}) != 1:
		return "its answer names no one new comment with these words on the post"
	on, own_id = min(ours, key=lambda named: (f"urn:li:{named[0]}" != post_thread_urn, named))
	return {"commentUrn": f"urn:li:comment:({on},{own_id})"}


def reaction_outcome(answer: Any) -> dict[str, Any]:
	"""What LinkedIn's answer to a like's one POST says: `accepted` for a 2xx
	— LinkedIn's own success, which its reaction API gives with an empty body
	— `blocked` with its stated refusal, `uncertain` for anything else, which
	only the post's data read back settles."""
	status = answer.get("status") if isinstance(answer, dict) else None
	if not isinstance(status, int) or isinstance(status, bool):
		return {"state": "uncertain", "error": "the page handed back no answer to the like's request"}
	if status == 0:
		failed = answer.get("error") or "no status"
		return {"state": "uncertain", "error": f"LinkedIn did not answer the like's request: {failed}"}
	if 200 <= status < 300:
		return {"state": "accepted", "status": status}
	return _refusal_or_unsettled(answer, status, "the like")


def answer_fingerprint(answer: Any) -> str:
	"""A hash of an answer's SHAPE — the keys its JSON holds and the types of
	its entities — with no value in it, for the log."""
	try:
		parsed = json.loads(answer.get("body")) if isinstance(answer, dict) and isinstance(answer.get("body"), str) else None
	except json.JSONDecodeError:
		parsed = None
	tokens = {f"top:{key}" for key in parsed} if isinstance(parsed, dict) else set()
	tokens.update(f"type:{entity.get('$type')}" for entity in _entities(parsed))
	return hashlib.sha256("\n".join(sorted(tokens)).encode()).hexdigest()[:16]


def _refusal_or_unsettled(answer: dict[str, Any], status: int, what: str) -> dict[str, Any]:
	reason = stated_reason(answer.get("body"))
	said = f"HTTP {status}: {reason}" if reason else f"HTTP {status}"
	if 400 <= status < 500 and status not in _UNSETTLED_STATUSES:
		return {"state": "blocked", "detail": f"LinkedIn refused {what} ({said})"}
	return {
		"state": "uncertain",
		"error": f"LinkedIn's answer settles nothing ({said})",
		**({"rateLimited": True} if status == 429 else {}),
	}


def _entities(parsed: Any) -> list[dict[str, Any]]:
	"""Every entity an answer holds: a normalized answer's `data` and its
	`included`, an answer that holds only its `value` unwrapped, or the answer
	itself."""
	if isinstance(parsed, dict) and set(parsed) == {"value"}:
		parsed = parsed["value"]
	if not isinstance(parsed, dict):
		return []
	if isinstance(parsed.get("data"), dict) or isinstance(parsed.get("included"), list):
		listed = [parsed.get("data"), *(parsed.get("included") or [])]
		return [entity for entity in listed if isinstance(entity, dict)]
	return [parsed]


def _words(entity: dict[str, Any]) -> str | None:
	for field in ("commentary", "commentV2"):
		value = entity.get(field)
		if isinstance(value, dict) and isinstance(value.get("text"), str):
			return value["text"]
	return None


def _named_comments(entity: dict[str, Any]) -> set[tuple[str, str]]:
	"""(the post's thread, the comment's id) of every comment urn the
	entity is keyed by, in either spelling."""
	named: set[tuple[str, str]] = set()
	for field in ("urn", "entityUrn", "dashEntityUrn"):
		value = entity.get(field)
		if not isinstance(value, str):
			continue
		value = value.removeprefix(_NORM_PREFIX)
		if match := _COMMENT_URN_RE.fullmatch(value):
			named.add((match.group(1), match.group(2)))
		elif match := _DASH_COMMENT_URN_RE.fullmatch(value):
			named.add((match.group(2), match.group(1)))
	return named


def _index(payload: Any) -> dict[str, Any]:
	included = payload.get("included") if isinstance(payload, dict) else None
	return {
		entity["entityUrn"]: entity
		for entity in included or []
		if isinstance(entity, dict) and isinstance(entity.get("entityUrn"), str)
	}


def _first_update(payload: Any, index: dict[str, Any]) -> dict[str, Any] | None:
	data = payload.get("data") if isinstance(payload, dict) else None
	refs = data.get("*elements") if isinstance(data, dict) else None
	for ref in refs if isinstance(refs, list) else []:
		update = index.get(ref) if isinstance(ref, str) else None
		if isinstance(update, dict):
			return update
	return None


def _entity(index: dict[str, Any], ref: Any, kind: str) -> dict[str, Any] | None:
	entity = index.get(ref) if isinstance(ref, str) else None
	return entity if isinstance(entity, dict) and str(entity.get("$type")).endswith(kind) else None
