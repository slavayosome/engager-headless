"""Extraction from LinkedIn's own JSON (normalized+json+2.1).

Congruent reads: the browser navigates the page a person would actually visit,
then this module parses that page's data from LinkedIn's API instead of scraping
markup. The page load is real, so its impression telemetry is real; this is a
more reliable parser, not a way to skip browsing.

Why JSON rather than the DOM: LinkedIn is migrating to obfuscated class names
and server-driven UI. A selector pack written 2026-07-30 was already partly
stale by 2026-08-02. JSON also carries things the DOM cannot express at all —
engagement counts, a hard person-vs-company discriminator, and sponsored-content
detection.

Shape: `data` is a skeleton holding reference strings; `included` is a flat
array of entities keyed by `entityUrn`. Resolving a post means following a urn
from `data["*elements"]` into `included`.
"""

from __future__ import annotations

import re
from typing import Any

from .member_identity import member_urn_from_mini_profile

SPONSORED_MARKER = "urn:li:sponsoredContentV2:"
MINI_PROFILE_PREFIX = "urn:li:fs_miniProfile:"

_SHARE_SLUG_RE = re.compile(
	r"/posts/[A-Za-z0-9_%\-\.]+?-(ugcPost|activity|share)-(\d+)-[A-Za-z0-9_-]+"
)
_URN_RE = re.compile(r"urn:li:(activity|ugcPost|share):([A-Za-z0-9_-]+)")


class VoyagerUnavailable(Exception):
	"""Voyager could not answer for this route. Deliberately NOT a SidecarError:
	it must never reach the wire — it means "fall back to the DOM".

	`gone` marks an answer that will not change on retry: the post or member
	is not there (404/410), not visible to this account (403), or the payload
	holds no such entity. `status` is LinkedIn's HTTP status where it answered
	with one, so a caller can tell a refusal of the request (413) from the rest.
	`transient` marks a failure of the connection or of LinkedIn's servers
	(network, timeout, 429, 5xx): the data was not seen, so it is not unrecognised
	data, and a retry may read it.
	"""

	def __init__(self, message: str, *, gone: bool = False, status: int | None = None, transient: bool = False) -> None:
		super().__init__(message)
		self.gone = gone
		self.status = status
		self.transient = transient


_PROFILE_PATH_RE = re.compile(r"/in/([A-Za-z0-9_%\-\.]+)")
_COMPANY_PATH_RE = re.compile(r"/company/([A-Za-z0-9_%\-\.]+)")
_COMPANY_SLUG_RE = re.compile(r"[a-z0-9_%\-\.]+")
_ALPHANUMERIC_RE = re.compile(r"[a-z0-9]")


def company_slug(value: str) -> str | None:
	"""A company page's public identifier, from the identifier itself or the
	page's address (`/company/<slug>/`, any suffix after it), folded as a
	profile slug is; None for anything that names no company page — a slug
	with no letter or digit in it (`.`, `..`, `-`) names none, and `..` would
	walk out of the path it is put in."""
	raw = str(value).strip()
	path = _COMPANY_PATH_RE.search(raw)
	slug = (path.group(1) if path else raw).rstrip("/").lower()
	return slug if _COMPANY_SLUG_RE.fullmatch(slug) and _ALPHANUMERIC_RE.search(slug) else None


def profile_slug(path: str) -> str | None:
	"""The member slug from a profile path.

	Must take the segment AFTER `/in/`, not the last segment: author discovery
	navigates to `/in/<slug>/recent-activity/all/`, where the last segment is
	"all".
	"""
	match = _PROFILE_PATH_RE.search(path or "")
	return match.group(1).rstrip("/") if match else None


def post_urn_from_share_url(share_url: Any) -> str | None:
	"""LinkedIn's own permalink is the authoritative identity.

	Verified across the captured payloads: shareUrl agreed with the post's real
	identity on 10/10 elements, while `updateMetadata.urn` disagreed on 4 of 5
	HOME FEED elements — there it is a per-viewer wrapper activity that is not
	the post. Commenting on a wrapper targets the wrong entity, so shareUrl wins.
	"""
	if not isinstance(share_url, str) or not share_url:
		return None
	match = _SHARE_SLUG_RE.search(share_url)
	if match:
		return f"urn:li:{match.group(1)}:{match.group(2)}"
	direct = _URN_RE.search(share_url)
	return f"urn:li:{direct.group(1)}:{direct.group(2)}" if direct else None


def snowflake_ms(post_urn: str | None) -> int | None:
	"""Publication time in ms, encoded in the high bits of the id (id >> 22).

	Exact, needs no extra request, and independent of markup. Python ints are
	arbitrary precision so no BigInt dance is required here (the JS side does
	need it — these ids exceed Number.MAX_SAFE_INTEGER).
	"""
	if not post_urn:
		return None
	match = _URN_RE.search(post_urn)
	return snowflake_id_ms(match.group(2)) if match else None


def snowflake_id_ms(numeric_id: str) -> int | None:
	"""The same decoding for a bare id — a comment's, whose urn carries its
	post's id as well."""
	if not numeric_id.isdigit():
		return None
	ms = int(numeric_id) >> 22
	# Bound to LinkedIn's plausible lifetime so a non-snowflake numeric id fails
	# closed rather than inventing a date.
	if ms < 1104537600000:
		return None
	return ms


def own_public_identifier(payload: dict[str, Any]) -> str | None:
	"""The connected member's public identifier from /voyager/api/me.

	Replaces navigating to /in/me/ and reading the URL. That probe raced a
	redirect: /in/me/ resolves to /in/<slug>/, but document.readyState can report
	"complete" on the pre-redirect document, so the check saw ".../in/me" and
	refused the account. One XHR has no redirect to race.
	"""
	reference = (payload.get("data") or {}).get("*miniProfile")
	if not isinstance(reference, str):
		return None
	entity = _index(payload).get(reference) or {}
	identifier = entity.get("publicIdentifier")
	return str(identifier) if identifier else None


def own_member_id(payload: dict[str, Any]) -> str | None:
	"""The connected member's own id from /voyager/api/me: the `ACoAA…` its
	mini profile's urn ends in. Every profile urn of theirs carries the same
	id — `fs_miniProfile` here, `fsd_profile` as a messaging mailbox."""
	reference = (payload.get("data") or {}).get("*miniProfile")
	if not isinstance(reference, str) or not reference.startswith(MINI_PROFILE_PREFIX):
		return None
	return reference.removeprefix(MINI_PROFILE_PREFIX) or None


def own_numeric_member_id(payload: dict[str, Any]) -> str | None:
	"""The connected member's number from /voyager/api/me — `plainId`, which
	its mini profile's `objectUrn` (`urn:li:member:<N>`) repeats. The number a
	profile page's data keys a member's invitation by; None where /me names
	none, or names two."""
	data = payload.get("data") or {}
	plain = data.get("plainId")
	numbers = {str(plain)} if isinstance(plain, int) and not isinstance(plain, bool) and plain > 0 else set()
	reference = data.get("*miniProfile")
	entity = (_index(payload).get(reference) if isinstance(reference, str) else None) or {}
	match = re.fullmatch(r"urn:li:member:([0-9]{1,20})", str(entity.get("objectUrn") or ""))
	if match:
		numbers.add(match.group(1))
	return numbers.pop() if len(numbers) == 1 else None


def own_display_name(payload: dict[str, Any]) -> str | None:
	"""The connected member's display name from /voyager/api/me.

	PROFILE_JS reads `main h1, h1.text-heading-xlarge, h1` — and LinkedIn's
	profile page now renders ZERO h1 elements (the name sits in an h2 under
	hashed classes). displayName came back empty, so fetch_own_profile returned
	None and voice learning had no identity to work from.
	"""
	reference = (payload.get("data") or {}).get("*miniProfile")
	if not isinstance(reference, str):
		return None
	entity = _index(payload).get(reference) or {}
	name = " ".join(
		str(part) for part in (entity.get("firstName"), entity.get("lastName")) if part
	).strip()
	return name or None


def own_headline(payload: dict[str, Any]) -> str | None:
	"""The connected member's headline from /voyager/api/me: the `occupation` of
	the same mini profile that names them, as it is read for other people
	(`_author`). None where the profile carries none — the sign-in step then
	draws no headline line rather than an empty one."""
	reference = (payload.get("data") or {}).get("*miniProfile")
	if not isinstance(reference, str):
		return None
	entity = _index(payload).get(reference) or {}
	headline = str(entity.get("occupation") or "").strip()
	return headline or None


def _index(payload: dict[str, Any]) -> dict[str, Any]:
	out: dict[str, Any] = {}
	for entity in payload.get("included") or []:
		if isinstance(entity, dict) and entity.get("entityUrn"):
			out[entity["entityUrn"]] = entity
	return out


def _text(node: Any) -> str:
	"""`{text: {text: "..."}}` is LinkedIn's TextViewModel nesting."""
	if isinstance(node, dict):
		inner = node.get("text")
		if isinstance(inner, dict):
			return str(inner.get("text") or "")
		if isinstance(inner, str):
			return inner
	return ""


def _author(update: dict[str, Any], idx: dict[str, Any]) -> dict[str, Any]:
	"""Resolve the actor.

	Members and companies use DIFFERENT reference keys: `*miniProfile` carries a
	publicIdentifier, `*miniCompany` a universalName. Handling only the member
	branch silently drops every company-authored post's identity — that is
	exactly what an early prototype did, resolving 8/10 instead of 10/10.
	"""
	actor = update.get("actor") or {}
	out: dict[str, Any] = {}

	name = _text(actor.get("name"))
	if name:
		out["authorName"] = name
	headline = _text(actor.get("description"))
	if headline:
		out["authorHeadline"] = headline

	actor_urn = str(actor.get("urn") or "")
	if actor_urn:
		out["authorIsCompany"] = actor_urn.startswith("urn:li:company:")
		out["authorUrn"] = actor_urn

	attributes = ((actor.get("image") or {}).get("attributes") or [])
	attribute = attributes[0] if attributes else {}
	if not isinstance(attribute, dict):
		attribute = {}
	member_ref = attribute.get("*miniProfile")
	company_ref = attribute.get("*miniCompany")
	entity = idx.get(member_ref or company_ref or "") or {}
	identifier = entity.get("publicIdentifier") or entity.get("universalName")
	if identifier:
		out["authorProfileId"] = str(identifier)
	return out


def _metrics(update: dict[str, Any], idx: dict[str, Any]) -> dict[str, Any] | None:
	"""Two hops: update -> socialDetail -> totalSocialActivityCounts.

	The socialDetail is sometimes rekeyed into the ugcPost namespace even when
	the update itself is activity-keyed, so this must follow the reference and
	never reconstruct the urn.
	"""
	social_ref = update.get("*socialDetail")
	social = idx.get(social_ref or "") or {}
	counts = idx.get(social.get("*totalSocialActivityCounts") or "") or {}
	if not counts:
		return None
	out: dict[str, Any] = {}
	if isinstance(counts.get("numLikes"), int):
		out["reactions"] = counts["numLikes"]
	if isinstance(counts.get("numComments"), int):
		out["comments"] = counts["numComments"]
	if isinstance(counts.get("numShares"), int):
		out["shares"] = counts["numShares"]
	return out or None


def parse_updates(payload: dict[str, Any]) -> list[dict[str, Any]]:
	"""Turn a feed/profile-updates response into DriverPost-shaped rows.

	Skips sponsored content: an ad rendered as a post would otherwise become a
	discovery candidate the owner could be asked to comment on.
	"""
	idx = _index(payload)
	data = payload.get("data") or {}
	refs = data.get("*elements")
	if not isinstance(refs, list):
		refs = []

	rows: list[dict[str, Any]] = []
	seen: set[str] = set()
	for ref in refs:
		update = idx.get(ref) if isinstance(ref, str) else None
		if not isinstance(update, dict):
			continue
		if SPONSORED_MARKER in str(update.get("entityUrn") or ""):
			continue

		social = update.get("socialContent") or {}
		share_url = social.get("shareUrl")
		post_urn = post_urn_from_share_url(share_url)
		if not post_urn:
			# updateMetadata.urn is a LAST resort: on the home feed it is a
			# per-viewer wrapper rather than the post itself.
			meta = update.get("updateMetadata") or {}
			post_urn = post_urn_from_share_url(meta.get("urn"))
		if not post_urn or post_urn in seen:
			continue
		seen.add(post_urn)

		row: dict[str, Any] = {
			"postUrn": post_urn,
			"contentText": _text(update.get("commentary")),
		}
		if isinstance(share_url, str) and share_url:
			row["url"] = share_url.split("?")[0]
		posted_at = snowflake_ms(post_urn)
		if posted_at is not None:
			row["postedAt"] = posted_at
		row.update(_author(update, idx))
		metrics = _metrics(update, idx)
		if metrics:
			row["metrics"] = metrics
		# A reshare wraps another update; record it so callers can avoid
		# double-counting the same underlying post.
		if update.get("*resharedUpdate"):
			row["isReshare"] = True
		rows.append(row)
	return rows


def owner_verdict(row: dict[str, Any], own_ids: frozenset[str]) -> bool | None:
	"""Whether a `parse_updates` row is a post the signed-in member WROTE: True,
	False, or None where its author cannot be placed at all.

	The own-posts read feeds the owner's voice and Brain, so it takes only their
	own words and fails closed on anything it cannot place. A reshare is out
	whole, repost-with-commentary included: the row's text is the update's
	commentary, and nothing here proves it is not the reshared author's. A
	company actor is out. The author is the member when the actor's urn is one
	of `own_ids` (the member urn, the profile urns) or the resolved identity is
	their public identifier, so a missing image reference does not hide them.
	None, a row naming neither, is reported by the caller apart from an empty
	feed.
	"""
	if row.get("isReshare") or row.get("authorIsCompany") is True:
		return False
	urn, ident = row.get("authorUrn"), _fold(row.get("authorProfileId"))
	if not urn and not ident:
		return None
	return urn in own_ids or ident in own_ids


# The verify reads, bounded where the snapshot is stored (protocol.ts mirrors
# every one of these).
THREAD_TEXT_MAX = 20_000
COMMENT_TEXT_MAX = 1_250
REPLY_TEXT_MAX = 500
MEDIA_TEXT_MAX = 2_000
ABOUT_MAX = 2_000
RECENT_POSTS_MAX = 5
# A company page's own fields, as `CompanyPageReadSchema` bounds them.
COMPANY_NAME_MAX = 500
COMPANY_REF_MAX = 500
COMPANY_SIZE_MAX = 200
COMPANY_INDUSTRY_MAX = 500

_COUNTRY_CODE_RE = re.compile(r"[A-Za-z]{2}")
_GEO_URN_RE = re.compile(r"urn:li:fsd_geo:[0-9]+")
_OBJECT_COMMENT_RE = re.compile(r"urn:li:fs_objectComment:\(([A-Za-z0-9_-]+),([^)]+)\)")


def _clip(value: str, limit: int) -> str:
	"""Truncate to `limit` UTF-16 code units, the length zod measures on the
	other side of the wire, without splitting a surrogate pair. A code-point
	slice lets one emoji past the bound and fails the whole read there."""
	units = 0
	for index, char in enumerate(value):
		units += 2 if ord(char) > 0xFFFF else 1
		if units > limit:
			return value[:index]
	return value


def _fold(identifier: Any) -> str:
	"""A Voyager identifier as `normalize_author_profile_id` keys it. Voyager
	hands back the bare slug, so folding the case is the whole normalization."""
	return str(identifier).strip().rstrip("/").lower() if identifier else ""


def _first_update(payload: dict[str, Any]) -> dict[str, Any] | None:
	idx = _index(payload)
	refs = (payload.get("data") or {}).get("*elements")
	for ref in refs if isinstance(refs, list) else []:
		update = idx.get(ref) if isinstance(ref, str) else None
		if isinstance(update, dict):
			return update
	return None


def comment_thread_ref(update_payload: dict[str, Any], post_urn: str) -> str:
	"""The `updateId` the comments endpoint keys a thread by, `activity:<id>`.

	Read off the update's own metadata, the reverse of the identity rule above:
	on the HOME FEED that urn is a per-viewer wrapper, but a single-post
	hydration has no wrapper, and its metadata names the activity the comments
	are keyed by while `shareUrl` may name the ugcPost. The post urn is the
	fallback.
	"""
	update = _first_update(update_payload) or {}
	urn = str((update.get("updateMetadata") or {}).get("urn") or post_urn)
	match = _URN_RE.search(urn)
	if not match:
		raise VoyagerUnavailable(f"no thread reference in {urn!r}")
	return f"{match.group(1)}:{match.group(2)}"


def _media_text(update: dict[str, Any]) -> str | None:
	"""What a post says outside its commentary: a link card or article's title
	and subtitle, a celebration's headline, a document's title. An image's
	component carries no text of its own, so it adds nothing."""
	content = update.get("content")
	if not isinstance(content, dict):
		return None
	parts: list[str] = []
	for key in ("title", "headline", "subtitle", "description"):
		value = _text(content.get(key)).strip()
		if value and value not in parts:
			parts.append(value)
	document = content.get("document")
	if isinstance(document, dict) and isinstance(document.get("title"), str) and document["title"].strip():
		parts.append(document["title"].strip())
	return _clip(" — ".join(parts), MEDIA_TEXT_MAX) or None


def _actor(actor: Any, idx: dict[str, Any]) -> dict[str, Any]:
	"""A commenter's identity, whichever way the payload spells the actor: the
	normalized union keyed by its member type, or the references inline."""
	if not isinstance(actor, dict):
		return {}
	for candidate in [actor, *(value for value in actor.values() if isinstance(value, dict))]:
		member = idx.get(candidate.get("*miniProfile") or "") or candidate.get("miniProfile")
		company = idx.get(candidate.get("*miniCompany") or "") or candidate.get("miniCompany")
		entity = member or company
		if not isinstance(entity, dict):
			continue
		identifier = _fold(entity.get("publicIdentifier") or entity.get("universalName"))
		if not identifier:
			continue
		out: dict[str, Any] = {"authorProfileId": identifier}
		if member:
			member_urn = member_urn_from_mini_profile(member)
			if member_urn:
				out["memberUrn"] = member_urn
		else:
			out["authorIsCompany"] = True
		name = (
			" ".join(str(part) for part in (entity.get("firstName"), entity.get("lastName")) if part).strip()
			if member
			else str(entity.get("name") or "").strip()
		)
		if name:
			out["authorName"] = name
		headline = str(entity.get("occupation") or "").strip()
		if headline:
			out["authorHeadline"] = headline
		return out
	return {}


def _comment_urn(entity: dict[str, Any]) -> str | None:
	"""`urn:li:comment:(<thread>,<id>)`, from the entity's own `urn` or, when
	only the normalized key is present, rebuilt from it."""
	urn = entity.get("urn")
	if isinstance(urn, str) and urn.startswith("urn:li:comment:"):
		return urn
	match = _OBJECT_COMMENT_RE.fullmatch(str(entity.get("entityUrn") or ""))
	return f"urn:li:comment:({match.group(2)},{match.group(1)})" if match else None


def _comment_text(entity: dict[str, Any]) -> str:
	return (_text(entity.get("commentV2")) or _text(entity.get("commentary"))).strip()


def _replies(entity: dict[str, Any], urn: str, idx: dict[str, Any]) -> list[dict[str, Any]]:
	"""The replies a comment carries: the ones its socialDetail embeds, and any
	entity in the payload naming it as their parent."""
	social = idx.get(entity.get("*socialDetail") or "") or {}
	listing = social.get("comments") if isinstance(social, dict) else None
	embedded: list[Any] = []
	if isinstance(listing, dict):
		for key in ("*elements", "elements"):
			if isinstance(listing.get(key), list):
				embedded.extend(listing[key])
	candidates = [idx.get(item) if isinstance(item, str) else item for item in embedded]
	candidates += [entity for entity in idx.values() if entity.get("parentCommentUrn") == urn]
	replies: dict[str, dict[str, Any]] = {}
	for reply in candidates:
		reply_urn = _comment_urn(reply) if isinstance(reply, dict) else None
		if reply_urn and reply_urn != urn:
			replies.setdefault(reply_urn, reply)
	return list(replies.values())


def parse_comments(
	payload: dict[str, Any],
	*,
	author_id: str,
	own_profile_id: str,
	max_comments: int,
) -> list[dict[str, Any]]:
	"""The thread's top-level comments in the order LinkedIn ranked them.

	`authorReplied` is whether the POST author answered underneath; `isOwner`
	is whether the connected account wrote the comment — the one fact that
	rejects a post the owner already joined, by hand or not. Both are only as
	true as the identities behind them, so a comment whose author does not
	resolve fails the read rather than reading as somebody else's.
	"""
	idx = _index(payload)
	refs = (payload.get("data") or {}).get("*elements")
	rows: list[dict[str, Any]] = []
	for ref in refs if isinstance(refs, list) else []:
		if len(rows) >= max_comments:
			break
		entity = idx.get(ref) if isinstance(ref, str) else None
		if not isinstance(entity, dict):
			continue
		urn = _comment_urn(entity)
		if not urn:
			continue
		commenter = _actor(entity.get("commenter"), idx)
		if not commenter:
			raise VoyagerUnavailable(f"the author of {urn} did not resolve")
		social = idx.get(entity.get("*socialDetail") or "") or {}
		counts = idx.get(social.get("*totalSocialActivityCounts") or "") if isinstance(social, dict) else None
		likes = counts.get("numLikes") if isinstance(counts, dict) else None
		author_reply = next(
			(
				reply
				for reply in _replies(entity, urn, idx)
				if author_id and _actor(reply.get("commenter"), idx).get("authorProfileId") == author_id
			),
			None,
		)
		row: dict[str, Any] = {
			"commentUrn": urn,
			**commenter,
			"text": _clip(_comment_text(entity), COMMENT_TEXT_MAX),
			"reactions": likes if isinstance(likes, int) and likes >= 0 else 0,
			"authorReplied": author_reply is not None,
			"isOwner": bool(own_profile_id) and commenter.get("authorProfileId") == own_profile_id,
		}
		reply_text = _clip(_comment_text(author_reply), REPLY_TEXT_MAX) if author_reply else ""
		if reply_text:
			row["authorReplyText"] = reply_text
		rows.append(row)
	return rows


def parse_post_thread(
	update_payload: dict[str, Any],
	comments_payload: dict[str, Any] | None,
	*,
	post_urn: str,
	own_profile_id: str,
	max_comments: int,
) -> dict[str, Any]:
	"""One post read in full: its text, what its media says, its counts, and
	up to `max_comments` of its comments.

	Counts follow the socialDetail reference exactly as discovery's metrics do,
	so a ugcPost-rekeyed socialDetail still answers. A post whose counts never
	resolve reports its comments as the ones read.

	`isOwner` covers the comments read. A thread with more comments than that
	cannot rule the owner out, and `counts.comments` says when it has them.
	"""
	update = _first_update(update_payload)
	if update is None:
		raise VoyagerUnavailable("no update in the post payload", gone=True)
	idx = _index(update_payload)
	author = _author(update, idx)
	author_id = _fold(author.get("authorProfileId"))
	comments = (
		parse_comments(
			comments_payload,
			author_id=author_id,
			own_profile_id=_fold(own_profile_id),
			max_comments=max_comments,
		)
		if comments_payload is not None and max_comments > 0
		else []
	)
	if comments and not author_id:
		raise VoyagerUnavailable("the post's author did not resolve, so no reply of theirs can be recognised")
	metrics = _metrics(update, idx) or {}
	thread: dict[str, Any] = {
		"postUrn": post_urn,
		"fullText": _clip(_text(update.get("commentary")), THREAD_TEXT_MAX),
		"counts": {
			"reactions": metrics.get("reactions", 0),
			"comments": metrics.get("comments", len(comments)),
			"reposts": metrics.get("shares", 0),
		},
		"comments": comments,
	}
	if author_id:
		thread["author"] = {
			"profileId": _clip(author_id, 500),
			"isCompany": bool(author.get("authorIsCompany", False)),
			**({"name": _clip(author["authorName"], 500)} if author.get("authorName") else {}),
			**({"headline": _clip(author["authorHeadline"], 1000)} if author.get("authorHeadline") else {}),
		}
	media = _media_text(update)
	if media:
		thread["mediaText"] = media
	posted_at = snowflake_ms(post_urn)
	if posted_at is not None:
		thread["postedAt"] = posted_at
	return thread


def _lookup_member(profile_payload: dict[str, Any]) -> dict[str, Any] | None:
	"""The member a profile lookup (`identity/dash/profiles?q=memberIdentity`)
	answers with: the first profile its elements name."""
	idx = _index(profile_payload)
	refs = (profile_payload.get("data") or {}).get("*elements")
	return next(
		(
			idx[ref]
			for ref in (refs if isinstance(refs, list) else [])
			if isinstance(ref, str) and ref.startswith("urn:li:fsd_profile:") and isinstance(idx.get(ref), dict)
		),
		None,
	)


def _place(profile: dict[str, Any]) -> dict[str, str]:
	"""Where a member is, from their profile's location: its ISO country code
	and the geo it names, each where the location names one.

	`primaryLocale` and `supportedLocales` carry a `country` too, but that is
	the LANGUAGE the profile is written in — an English profile in Bangalore
	reads `US` there — so a profile with no location has no country, never a
	locale's."""
	out: dict[str, str] = {}
	location = profile.get("location")
	country = location.get("countryCode") if isinstance(location, dict) else None
	if isinstance(country, str) and _COUNTRY_CODE_RE.fullmatch(country.strip()):
		out["country"] = country.strip().upper()
	geo = profile.get("geoLocation")
	geo_urn = geo.get("geoUrn") if isinstance(geo, dict) else None
	if isinstance(geo_urn, str) and _GEO_URN_RE.fullmatch(geo_urn):
		out["geoUrn"] = geo_urn
	return out


def member_place(profile_payload: dict[str, Any], profile_urn: str) -> dict[str, str] | None:
	"""Where the member `profile_urn` names is, from a profile lookup's payload
	(`_place`) — `{}` where their location names nothing — or None where the
	lookup answered with no member, or another one."""
	profile = _lookup_member(profile_payload)
	if profile is None or profile.get("entityUrn") != profile_urn:
		return None
	return _place(profile)


_POSITION_URN_RE = re.compile(r"urn:li:(?:fsd_position|fsd_profilePosition):\(([^,()]+),")


def _started(entity: dict[str, Any]) -> tuple[int, int]:
	"""When a position began, as (year, month); (0, 0) where it names no
	start, so a dated position outranks an undated one."""
	dates = entity.get("dateRange")
	start = dates.get("start") if isinstance(dates, dict) else None
	if not isinstance(start, dict):
		return (0, 0)
	year, month = start.get("year"), start.get("month")
	return (
		year if isinstance(year, int) and not isinstance(year, bool) else 0,
		month if isinstance(month, int) and not isinstance(month, bool) else 0,
	)


def _current_company(profile_payload: dict[str, Any], profile: dict[str, Any]) -> dict[str, str] | None:
	"""The member's current role and the company page it links to, where the
	profile payload carries one: the newest of THEIR positions with no end date
	that names a company entity by reference, that entity holding its page's
	public identifier (`universalName`). None where the payload carries no such
	position, which the plain member lookup does not: nothing is guessed from
	the headline.

	The payload may carry positions of other members (the people it suggests,
	the people who recommended them), so a position counts only where its own
	urn names the member the lookup answered with (`profile`, whose urn is
	`urn:li:fsd_profile:<id>`, as `urn:li:fsd_position:(<id>,<n>)` names its
	member). A page identifier longer than the wire carries is no page."""
	member = str(profile.get("entityUrn") or "").removeprefix("urn:li:fsd_profile:")
	if not member or ":" in member:
		return None
	idx = _index(profile_payload)
	best: tuple[tuple[int, int], dict[str, str]] | None = None
	for entity in idx.values():
		owner = _POSITION_URN_RE.match(str(entity.get("entityUrn") or ""))
		if owner is None or owner.group(1) != member:
			continue
		dates = entity.get("dateRange")
		if isinstance(dates, dict) and dates.get("end"):
			continue
		company = idx.get(str(entity.get("*company") or entity.get("companyUrn") or ""))
		slug = company_slug(str(company.get("universalName") or "")) if isinstance(company, dict) else None
		if not slug or len(slug) > COMPANY_REF_MAX:
			continue
		started = _started(entity)
		if best is not None and started <= best[0]:
			continue
		role: dict[str, str] = {"companyRef": slug}
		title = entity.get("title")
		if isinstance(title, str) and title.strip():
			role["title"] = _clip(title.strip(), COMPANY_NAME_MAX)
		name = company.get("name") or entity.get("companyName")
		if isinstance(name, str) and name.strip():
			role["company"] = _clip(name.strip(), COMPANY_NAME_MAX)
		best = (started, role)
	return best[1] if best else None


def _staff_size(company: dict[str, Any]) -> str | None:
	"""A page's size band, as it words it: its staff count range, else none."""
	band = company.get("staffCountRange")
	if not isinstance(band, dict) or not isinstance(band.get("start"), int):
		return None
	end = band.get("end")
	return f"{band['start']}-{end} employees" if isinstance(end, int) else f"{band['start']}+ employees"


def parse_company_page(payload: dict[str, Any], *, company_ref: str) -> dict[str, Any]:
	"""A company's own page as `organization/companies?q=universalName`
	answers it: its name, size band, first industry, About and followers, each
	bounded, and nothing else — no person, no address beyond the page. A
	payload naming no company, or another one, is unavailable for good."""
	idx = _index(payload)
	refs = (payload.get("data") or {}).get("*elements")
	company = next(
		(idx[ref] for ref in (refs if isinstance(refs, list) else []) if isinstance(ref, str) and isinstance(idx.get(ref), dict)),
		None,
	)
	if company is None or company_slug(str(company.get("universalName") or "")) != company_ref:
		raise VoyagerUnavailable("no such company in the payload", gone=True)
	out: dict[str, Any] = {"companyRef": company_ref}
	name = company.get("name")
	if isinstance(name, str) and name.strip():
		out["name"] = _clip(name.strip(), COMPANY_NAME_MAX)
	size = _staff_size(company)
	if size:
		out["size"] = _clip(size, COMPANY_SIZE_MAX)
	industries = company.get("companyIndustries")
	if not isinstance(industries, list):
		industries = [idx.get(ref) for ref in company.get("*companyIndustries") or [] if isinstance(ref, str)]
	industry = next((item.get("localizedName") for item in industries if isinstance(item, dict) and item.get("localizedName")), None)
	if isinstance(industry, str) and industry.strip():
		out["industry"] = _clip(industry.strip(), COMPANY_INDUSTRY_MAX)
	about = company.get("description")
	if isinstance(about, str) and about.strip():
		out["about"] = _clip(about.strip(), ABOUT_MAX)
	following = company.get("followingInfo")
	if not isinstance(following, dict):
		following = idx.get(str(company.get("*followingInfo") or ""))
	followers = following.get("followerCount") if isinstance(following, dict) else None
	if isinstance(followers, int) and not isinstance(followers, bool) and followers >= 0:
		out["followers"] = followers
	return out


def parse_author_profile(
	profile_payload: dict[str, Any],
	updates_payload: dict[str, Any] | None,
	*,
	profile_id: str,
) -> dict[str, Any]:
	"""A member's profile as the verify stage reads it, with up to five recent
	posts for the author's own register.

	The member lookup carries no follower count, so `followers` stays absent
	rather than guessed, and a `currentRole` only where it carries a current
	position linking a company page (`_current_company`). Where the member is
	comes from their profile's location (`_place`).
	"""
	profile = _lookup_member(profile_payload)
	if profile is None:
		raise VoyagerUnavailable("no member profile in the payload", gone=True)
	out: dict[str, Any] = {"profileId": profile_id, "isCompanyPage": False}
	name = " ".join(str(part) for part in (profile.get("firstName"), profile.get("lastName")) if part).strip()
	if name:
		out["name"] = name
	headline = profile.get("headline")
	if isinstance(headline, str) and headline.strip():
		out["headline"] = headline.strip()
	about = profile.get("summary")
	if isinstance(about, str) and about.strip():
		out["about"] = _clip(about.strip(), ABOUT_MAX)
	out.update(_place(profile))
	role = _current_company(profile_payload, profile)
	if role:
		out["currentRole"] = role
	recent: list[dict[str, Any]] = []
	for row in parse_updates(updates_payload)[:RECENT_POSTS_MAX] if updates_payload else []:
		post: dict[str, Any] = {"postUrn": row["postUrn"], "text": _clip(str(row.get("contentText") or ""), THREAD_TEXT_MAX)}
		if isinstance(row.get("postedAt"), int):
			post["postedAt"] = row["postedAt"]
		recent.append(post)
	out["recentPosts"] = recent
	return out
