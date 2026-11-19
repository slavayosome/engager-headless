"""The replies directly under one of our comments, read from the post page's markup.

The browser hands over the rendered page as markup — one `outerHTML` — and every
rule of the read runs here, over that string: which row is ours, which rows
reply to it directly, who wrote each, what each says. A rule written into the
page could only be exercised against a live session; here a saved page
exercises it (`tests/fixtures/replies/`). The page's own scripts decide
nothing: one serialises the markup, one presses a replies control under our row.

Nothing here reads layout. The sidecar's window is hidden, and the redesign
animates controls in from 0x0 only while a window is visible (read live
2026-10-09), so a rule gated on a bounding box would read a rendered reply as
absent. Markup is the same on screen or off.

FAIL CLOSED. Structure this module does not recognise is `UI_DRIFT` with the
page's fingerprint and a redacted excerpt, never a best guess, and a read that
could not finish loading is `THREAD_INCOMPLETE`: either way the caller changes
nothing. A reply whose parent row is not ours is omitted, never attributed —
LinkedIn threads are two levels deep, so a reply to a sibling comment sits
under the sibling's row, and a reply to one of our replies sits beside it.

The redesign's nested replies are RECONSTRUCTED from the 2026-10-08 notes
(`componentkey` rows, `expandable-text-box` bodies). What the live page of
2026-10-12 renders is flat (`tests/fixtures/agent_reader/`, scrubbed captures):
no row nests another, a reply is its own row right after the comment it
answers, and the reply count is a bare number beside the Reply control. A row
beside our comment is read as a reply to it only where that count vouches for
it (`SiblingThread.counted`); a count the rows beside it fall short of, with no
control for older replies between them, is drift rather than "no replies".
Where the page prints no count, a row is read as a reply to ours only where a
notification about OUR comment names it (`vouched_reply_urns`, from
`notifications.py`): LinkedIn's own word, never the row's place on the page.

The page's own data says it first. Where it lists our comment's thread
(`thread_data.py`), the replies it lists in that thread are ours — each read
by its own row, count or no count — and none of the rules above is needed to
say which rows answer us. Where it does not, they decide as before.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import TYPE_CHECKING, Any, Iterator
from urllib.parse import unquote, urlparse

from .protocol import SELECTOR_PACK_VERSION, SidecarError
from .voyager import snowflake_id_ms

if TYPE_CHECKING:
	from .thread_data import PageThreads

# Serialises the page and where it is. `main` holds the post and its comments;
# the body is the fallback, never the first choice, because it also carries the
# messaging overlay.
SNAPSHOT_JS = r"""() => JSON.stringify({
  url: location.href,
  html: (document.querySelector('main') || document.body).outerHTML
})"""

REDESIGN_ROW_PREFIX = "replaceableComment_"
BODY_TEST_ID = "expandable-text-box"
LEGACY_BODY_CLASSES = (
	"comments-comment-item__main-content",
	"comments-comment-item-content-body",
	"comments-comment-item__inline-show-more-text",
	"update-components-text",
)
POST_CARD_KEY_PREFIX = "update-card"

# A control that loads replies under a comment: "Load previous replies", "See
# more replies", "View 3 replies", or a bare "3 replies". The page script that
# presses one compiles this same pattern over the same label, so the two cannot
# disagree about which control is meant.
REPLY_EXPANDER_PATTERN = r"\b(?:load|show|see|view)\b.*\brepl(?:y|ies)\b|^\d[\d,]*\s+repl(?:y|ies)$"
_REPLY_EXPANDER_RE = re.compile(REPLY_EXPANDER_PATTERN, re.IGNORECASE)
_REPLY_COUNT_RE = re.compile(r"^(\d[\d,]*)\s+repl(?:y|ies)$", re.IGNORECASE)
# The redesign's reaction count on a comment: "1 reaction", read as text beside
# the reaction icons (live 2026-10-12), never as a control's label.
_REACTION_COUNT_RE = re.compile(r"^(\d[\d,]*)\s+reactions?$", re.IGNORECASE)
# The words LOAD_MORE_COMMENTS_JS presses.
_MORE_COMMENTS_RE = re.compile(r"load more comments|show more comments|more comments", re.IGNORECASE)
# What LinkedIn prints on a post's own address in place of a post deleted or
# removed (read live 2026-10-19): "Post not found", then "This post was deleted
# or removed". Its own words, never a guess at what a page without the post
# means.
_POST_DELETED_RE = re.compile(
	r"\bpost not found\b.*\bthis post (?:was|has been) deleted or removed\b", re.IGNORECASE | re.DOTALL
)
# A long body renders its own expander inside the box; the full text is there.
_SEE_MORE_RE = re.compile(r"\s*(?:…|\.\.\.)\s*(?:see\s+)?more$", re.IGNORECASE)
_COMMENT_URN_RE = re.compile(
	r"urn:li:comment:\((?:urn:li:)?(?:activity|ugcPost|share):[A-Za-z0-9_-]+,([A-Za-z0-9_-]+)\)"
	r"|urn:li:comment:([A-Za-z0-9_-]+)"
)
_PROFILE_PATH_RE = re.compile(r"^/(in|company)/([A-Za-z0-9_%\-\.]+)/?")

# Where the TypeScript schema bounds a reply, in the UTF-16 units it counts. A
# body past it swallowed more than one comment: drift, not a long reply.
MAX_REPLY_TEXT = 3_000
MAX_DISPLAY_NAME = 200
EXCERPT_CHARS = 2_000

_VOID_TAGS = frozenset(
	{"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
)
_SILENT_TAGS = frozenset({"script", "style", "template", "noscript", "svg"})
_BLOCK_TAGS = frozenset(
	{
		"address", "article", "aside", "blockquote", "dd", "div", "dl", "dt", "figcaption", "figure",
		"footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "li", "main", "nav", "ol", "p",
		"pre", "section", "table", "tr", "ul",
	}
)


def clean(value: str) -> str:
	return " ".join(value.split())


def utf16_len(value: str) -> int:
	return len(value.encode("utf-16-le")) // 2


def text_hash(text: str) -> str:
	return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(eq=False)
class Element:
	tag: str
	attrs: dict[str, str]
	parent: Element | None = None
	children: list[Element | str] = field(default_factory=list)

	def get(self, name: str) -> str | None:
		return self.attrs.get(name)

	def has_class(self, name: str) -> bool:
		return name in (self.attrs.get("class") or "").split()

	def iter(self) -> Iterator[Element]:
		"""This element and every element under it, in document order."""
		stack: list[Element] = [self]
		while stack:
			node = stack.pop()
			yield node
			stack.extend(child for child in reversed(node.children) if isinstance(child, Element))

	def contains(self, other: Element) -> bool:
		node: Element | None = other
		while node is not None:
			if node is self:
				return True
			node = node.parent
		return False

	def lines(self) -> list[str]:
		"""The text as innerText breaks it into lines, read off the markup: `<br>`
		and block elements end a line; scripts, styles and icons say nothing."""
		parts: list[str] = []
		stack: list[Element | str] = [self]
		while stack:
			node = stack.pop()
			if isinstance(node, str):
				parts.append(node)
				continue
			if node.tag in _SILENT_TAGS:
				continue
			if node.tag == "br":
				parts.append("\n")
				continue
			if node.tag in _BLOCK_TAGS and node is not self:
				parts.append("\n")
				stack.append("\n")
			stack.extend(reversed(node.children))
		return [line for line in (clean(line) for line in "".join(parts).split("\n")) if line]

	def text(self) -> str:
		return " ".join(self.lines())

	def runs(self) -> list[str]:
		"""Every text node on its own, in document order, whitespace collapsed
		and the empty ones dropped; scripts, styles and icons say nothing."""
		parts: list[str] = []
		stack: list[Element | str] = [self]
		while stack:
			node = stack.pop()
			if isinstance(node, str):
				parts.append(node)
			elif node.tag not in _SILENT_TAGS:
				stack.extend(reversed(node.children))
		return [run for run in (clean(part) for part in parts) if run]

	def words(self) -> str:
		"""Every text node, a space between each — what the page script reads as
		a control's label, so the two read one label the same way."""
		return " ".join(self.runs())


class _TreeBuilder(HTMLParser):
	"""A tree over browser-serialised markup. `outerHTML` closes every element
	it opens, so a stack is the whole of HTML's tree construction here."""

	def __init__(self) -> None:
		super().__init__(convert_charrefs=True)
		self.root = Element("#document", {})
		self._open: list[Element] = [self.root]

	def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
		element = Element(tag, {name: value or "" for name, value in attrs}, self._open[-1])
		self._open[-1].children.append(element)
		if tag not in _VOID_TAGS:
			self._open.append(element)

	def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
		self._open[-1].children.append(Element(tag, {name: value or "" for name, value in attrs}, self._open[-1]))

	def handle_endtag(self, tag: str) -> None:
		for depth in range(len(self._open) - 1, 0, -1):
			if self._open[depth].tag == tag:
				del self._open[depth:]
				return

	def handle_data(self, data: str) -> None:
		self._open[-1].children.append(data)


def parse_markup(html: str) -> Element:
	builder = _TreeBuilder()
	builder.feed(html)
	builder.close()
	return builder.root


@dataclass(frozen=True)
class Snapshot:
	url: str
	root: Element


def snapshot_from_page(raw: Any) -> Snapshot:
	"""What SNAPSHOT_JS returned, or drift when it is not that shape."""
	if not isinstance(raw, dict) or not isinstance(raw.get("url"), str) or not isinstance(raw.get("html"), str):
		raise SidecarError("UI_DRIFT", "the post page could not be serialised for reading")
	return Snapshot(url=raw["url"], root=parse_markup(raw["html"]))


def comment_id(urn: str) -> str | None:
	"""The trailing, globally-unique id of a comment urn, in whichever inner post
	spelling LinkedIn minted it (activity and ugcPost ids are independent)."""
	match = _COMMENT_URN_RE.fullmatch(urn)
	if not match:
		return None
	return match.group(1) or match.group(2)


def profile_identity(href: str | None) -> tuple[str, str] | None:
	"""(profile id, profile url) for a member or company link.

	The id is the bare lowercased slug — the canonical form
	`backend.normalize_author_profile_id` documents, pinned equal to it by the
	suite — so a reply's author is the same key every other read stores."""
	if not href:
		return None
	parsed = urlparse(href)
	if parsed.netloc and parsed.netloc not in {"www.linkedin.com", "linkedin.com"}:
		return None
	match = _PROFILE_PATH_RE.match(parsed.path)
	if not match:
		return None
	slug = match.group(2).rstrip("/").lower()
	return slug, f"https://www.linkedin.com/{match.group(1)}/{slug}/"


def _row_urn(element: Element) -> str | None:
	"""The comment urn a row is keyed by: the redesign's `componentkey`, else the
	legacy `data-id`. The row's OWN key — never a nested reply's markup."""
	key = element.get("componentkey")
	if key is not None and key.startswith(REDESIGN_ROW_PREFIX):
		urn = key[len(REDESIGN_ROW_PREFIX):]
		return urn if comment_id(urn) else None
	data_id = element.get("data-id")
	if data_id is not None and "urn:li:comment" in data_id:
		return data_id if comment_id(data_id) else None
	return None


def marked_as_row(element: Element) -> bool:
	"""Marked as a comment row, whether or not its key parses."""
	return (element.get("componentkey") or "").startswith(REDESIGN_ROW_PREFIX) or "urn:li:comment" in (
		element.get("data-id") or ""
	)


def is_body(element: Element) -> bool:
	return element.get("data-testid") == BODY_TEST_ID or any(element.has_class(name) for name in LEGACY_BODY_CLASSES)


def control_label(element: Element) -> str:
	"""A control's label: its words, else its aria-label."""
	return element.words() or clean(element.get("aria-label") or "")


@dataclass(eq=False)
class _Row:
	"""One comment. The legacy layout can render it as a wrapper around an
	entity that both carry its key; `element` is the innermost of them."""

	urn: str
	id: str
	elements: list[Element]

	@property
	def innermost(self) -> list[Element]:
		return [e for e in self.elements if not any(o is not e and e.contains(o) for o in self.elements)]

	@property
	def element(self) -> Element:
		return self.innermost[0]


class _Page:
	"""Every keyed comment row on one snapshot, and which row each sits under."""

	def __init__(self, root: Element) -> None:
		self.root = root
		self.rows: dict[str, _Row] = {}
		self._row_of: dict[int, _Row] = {}
		for element in root.iter():
			urn = _row_urn(element)
			key = comment_id(urn) if urn else None
			if urn is None or key is None:
				continue
			row = self.rows.setdefault(key, _Row(urn=urn, id=key, elements=[]))
			row.elements.append(element)
			self._row_of[id(element)] = row

	def nearest_row(self, element: Element, *, skip: _Row | None = None) -> _Row | None:
		node: Element | None = element
		while node is not None:
			owner = self._row_of.get(id(node))
			if owner is not None and owner is not skip:
				return owner
			node = node.parent
		return None

	def parent_row(self, row: _Row) -> _Row | None:
		"""The nearest row this one sits inside, skipping its own wrappers."""
		return self.nearest_row(row.element, skip=row)

	def own_region(self, row: _Row) -> Iterator[Element]:
		"""The row's elements, stopping at every row nested inside it."""
		stack: list[Element] = [row.element]
		while stack:
			node = stack.pop()
			owner = self._row_of.get(id(node))
			if owner is not None and owner is not row:
				continue
			yield node
			stack.extend(child for child in reversed(node.children) if isinstance(child, Element))

	def outside_body(self, row: _Row) -> Iterator[Element]:
		"""The row's own elements minus its body: the body is someone's words,
		and words can say "3 replies" or link to a profile."""
		bodies = [element for element in self.own_region(row) if is_body(element)]
		for element in self.own_region(row):
			if not any(body.contains(element) for body in bodies):
				yield element


def reply_count_beside(page: _Page, row: _Row) -> int | None:
	"""The number the redesign prints beside a comment's Reply control — its
	reply count, said twice over for screen readers ("1", "1") — or None where
	it prints none. Read outside the body, which is someone's words."""
	for element in page.outside_body(row):
		if element.tag != "button" or control_label(element).lower() != "reply" or element.parent is None:
			continue
		runs = [
			run
			for sibling in element.parent.children
			if isinstance(sibling, Element) and sibling is not element
			for run in sibling.runs()
		]
		numbers = {run.replace(",", "") for run in runs}
		if len(numbers) == 1 and next(iter(numbers)).isdigit():
			return int(next(iter(numbers)))
	return None


def reaction_count(page: _Page, row: _Row) -> int | None:
	"""The reactions the row prints on itself — "1 reaction", "12 reactions" —
	or None where it prints none. Read outside the body, which is someone's
	words, and outside every row nested in it. Only an element holding the
	words alone counts, so a count is never read across two elements."""
	counts = {
		int(match.group(1).replace(",", ""))
		for element in page.outside_body(row)
		if element.tag not in _SILENT_TAGS
		and element.children
		and all(isinstance(child, str) for child in element.children)
		and (match := _REACTION_COUNT_RE.fullmatch(clean("".join(element.children))))  # type: ignore[arg-type]
	}
	return max(counts) if counts else None


@dataclass
class SiblingThread:
	"""One comment's thread as the redesign lays it out (read live 2026-10-12):
	no row nests another, and a reply is its own row right after the comment it
	answers. A thread is the comment's row and the rows after it up to the
	first empty `div` the list puts between threads; anything with words in
	between is the control that loads older replies, so the rows shown are
	only the newest."""

	comment: _Row
	replies: list[_Row] = field(default_factory=list)
	older_hidden: bool = False
	reply_count: int | None = None

	@property
	def counted(self) -> bool:
		"""Whether LinkedIn's own words vouch for every row beside the comment as
		a reply to it: the count beside its Reply control covers them, and none
		is older than the comment. Layout alone never makes a row a reply."""
		if self.reply_count is None or len(self.replies) > self.reply_count:
			return False
		since = snowflake_id_ms(self.comment.id)
		return all(
			since is None or (posted := snowflake_id_ms(reply.id)) is None or posted >= since
			for reply in self.replies
		)


def sibling_threads(page: _Page) -> dict[str, SiblingThread]:
	"""Each redesign comment's thread, by the comment's row id."""
	rows = {
		id(row.element): row
		for row in page.rows.values()
		if len(row.innermost) == 1
		and page.parent_row(row) is None
		and any((element.get("componentkey") or "").startswith(REDESIGN_ROW_PREFIX) for element in row.elements)
	}
	threads: dict[str, SiblingThread] = {}
	current: SiblingThread | None = None
	stack: list[Element | str] = [page.root]
	while stack:
		node = stack.pop()
		if isinstance(node, str):
			if current is not None and node.strip():
				current.older_hidden = True
			continue
		row = rows.get(id(node))
		if row is not None:
			if current is None:
				current = threads[row.id] = SiblingThread(row, reply_count=reply_count_beside(page, row))
			else:
				current.replies.append(row)
			continue
		if node.tag in _SILENT_TAGS:
			continue
		if node.tag == "div" and not node.children:
			current = None
			continue
		stack.extend(reversed(node.children))
	return threads


def reply_parents(page: _Page) -> dict[str, _Row]:
	"""Each reply row's comment, by the reply's row id: the row it nests in on
	the legacy page, or on the redesign the comment it stands beside where
	LinkedIn's count vouches for it (`SiblingThread.counted`)."""
	parents = {row.id: parent for row in page.rows.values() if (parent := page.parent_row(row)) is not None}
	for thread in sibling_threads(page).values():
		if thread.counted:
			parents.update((reply.id, thread.comment) for reply in thread.replies)
	return parents


@dataclass(frozen=True)
class ThreadReading:
	"""What one snapshot of the post page says about our comment."""

	snapshot: Snapshot
	page: _Page
	comment_urn: str
	on_post: bool
	# The post's own address, no post on it, and LinkedIn saying it was deleted
	# or removed (`_post_deleted`): the one page that proves the post gone.
	post_deleted: bool
	ours: _Row | None
	ambiguous: bool
	more_comments: bool
	children: list[_Row]
	reply_count: int | None
	expandable: bool
	# Our row's thread where the redesign lays it out flat: the replies beside
	# it rather than under it (`sibling_threads`). None on a page that nests.
	beside: SiblingThread | None

	@property
	def complete(self) -> bool:
		"""Every reply LinkedIn holds for our row is in the markup — by its own
		count when it shows one, else by no control left that loads more."""
		if self.reply_count is not None:
			return len(self.children) >= self.reply_count
		return not self.expandable

	@property
	def wants_more_comments(self) -> bool:
		return self.ours is None and not self.ambiguous and self.more_comments

	@property
	def wants_more_replies(self) -> bool:
		return self.ours is not None and not self.complete and self.expandable


def read_thread(snapshot: Snapshot, *, post_urn: str, comment_urn: str) -> ThreadReading:
	wanted = comment_id(comment_urn)
	if wanted is None:
		raise SidecarError("INVALID_REQUEST", "commentUrn is not a recognised LinkedIn comment urn")
	page = _Page(snapshot.root)
	row = page.rows.get(wanted)
	ambiguous = row is not None and len(row.innermost) > 1
	ours = row if row is not None and not ambiguous else None
	children = [candidate for candidate in page.rows.values() if ours and page.parent_row(candidate) is ours]
	reply_count: int | None = None
	expandable = False
	if ours is not None:
		for element in page.outside_body(ours):
			label = control_label(element)
			count = _REPLY_COUNT_RE.fullmatch(label)
			if count:
				reply_count = max(reply_count or 0, int(count.group(1).replace(",", "")))
			if element.tag == "button" and element.get("aria-expanded") != "true" and _REPLY_EXPANDER_RE.search(label):
				expandable = True
	return ThreadReading(
		snapshot=snapshot,
		page=page,
		comment_urn=comment_urn,
		on_post=_on_post(snapshot, post_urn),
		post_deleted=_post_deleted(snapshot, post_urn),
		ours=ours,
		ambiguous=ambiguous,
		more_comments=any(
			element.tag == "button" and _MORE_COMMENTS_RE.search(control_label(element)) for element in snapshot.root.iter()
		),
		children=children,
		reply_count=reply_count,
		expandable=expandable,
		beside=sibling_threads(page).get(ours.id) if ours is not None else None,
	)


def _on_address(snapshot: Snapshot, post_urn: str) -> bool:
	return unquote(urlparse(snapshot.url).path).rstrip("/") == f"/feed/update/{post_urn}"


def _on_post(snapshot: Snapshot, post_urn: str) -> bool:
	"""Whether this page is the post: its own address, and the post on it — the
	legacy container keyed by the urn, or the redesign's card holding the exact
	permalink. A redirect away from a post must never read as our comment gone."""
	if not _on_address(snapshot, post_urn):
		return False
	permalink = f"https://www.linkedin.com/feed/update/{post_urn}"
	for element in snapshot.root.iter():
		if element.get("data-urn") == post_urn:
			return True
		if element.get("role") == "listitem" and (element.get("componentkey") or "").startswith(POST_CARD_KEY_PREFIX):
			if any(link.tag == "a" and _canonical(link.get("href")) == permalink for link in element.iter()):
				return True
	return False


def _post_deleted(snapshot: Snapshot, post_urn: str) -> bool:
	"""Whether LinkedIn shows the post as deleted or removed: its own address,
	no post on it, and the page saying so in LinkedIn's words. A redirect, or a
	page that has not rendered the post yet, says nothing of the kind."""
	if not _on_address(snapshot, post_urn) or _on_post(snapshot, post_urn):
		return False
	return _POST_DELETED_RE.search(snapshot.root.text()) is not None


def _canonical(href: str | None) -> str:
	if not href:
		return ""
	parsed = urlparse(href)
	origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.netloc else "https://www.linkedin.com"
	return f"{origin}{unquote(parsed.path)}".rstrip("/")


def comment_replies(
	reading: ThreadReading,
	*,
	own_profile_id: str,
	since_ms: int | None,
	limit: int,
	observed_at: int,
	vouched_reply_urns: frozenset[str] = frozenset(),
	threads: PageThreads | None = None,
	room_reply_urn: str | None = None,
) -> dict[str, Any]:
	"""The wire result for one settled reading, or the failure that keeps the
	caller from changing anything. `vouched_reply_urns` are the replies a
	notification about OUR comment names: each is read as a reply to it
	wherever the page lays it out, unless the page nests it under another.
	`threads` is the page's own thread data, None where the page carried none
	`thread_data.py` recognises: the replies it lists in our comment's thread
	are our replies (`repliesFrom: "page_data"`), and where it does not list
	our comment as a thread the markup's rules decide (`"markup"`)."""
	fingerprint = page_fingerprint(reading.snapshot.root)
	listed = threads.replies_to(reading.comment_urn) if threads is not None else None
	if not reading.on_post:
		# Only LinkedIn's own page for a post deleted or removed is worth no
		# retry; any other page without the post may load as it next time.
		if reading.post_deleted:
			raise SidecarError("THREAD_UNAVAILABLE", "LinkedIn shows the post as deleted or removed")
		raise SidecarError("THREAD_UNAVAILABLE", "the post page did not load as the post", retryable=True)
	if reading.ambiguous:
		raise _drift("more than one comment row is keyed by our comment", reading.snapshot.root, fingerprint)
	# Every row that could be ours, or under ours, must be one this module can
	# name: absence is decided over keyed rows only, and so is attribution.
	for element in reading.snapshot.root.iter():
		if marked_as_row(element) and _row_urn(element) is None and reading.page.nearest_row(element) is reading.ours:
			raise _drift("a comment row carries no comment urn", element, fingerprint)
	result: dict[str, Any] = {
		"replies": [],
		"truncated": False,
		"pageFingerprint": fingerprint,
		"selectorPack": SELECTOR_PACK_VERSION,
	}
	if reading.ours is None:
		if not reading.page.rows:
			raise SidecarError("THREAD_INCOMPLETE", "the post's comments never rendered", retryable=True)
		if reading.more_comments:
			raise SidecarError("THREAD_INCOMPLETE", "our comment is not among the comments loaded", retryable=True)
		if threads is not None and threads.lists(reading.comment_urn):
			# The page's own data lists our comment: a row that never rendered
			# is not a comment gone.
			raise SidecarError("THREAD_INCOMPLETE", "our comment is listed and its row never rendered", retryable=True)
		return {"comment": {"present": False, "urn": reading.comment_urn}, **result}

	ours = reading.ours
	if not reading.complete:
		if reading.expandable:
			raise SidecarError("THREAD_INCOMPLETE", "replies under our comment are still collapsed", retryable=True)
		# Replies LinkedIn counts that no keyed row carries: the shape they
		# render in is one this module has never seen.
		raise _drift(
			f"our comment shows {reading.reply_count} replies and {len(reading.children)} reply rows were recognised",
			ours.element,
			fingerprint,
		)
	children, reply_count, older_hidden = reading.children, reading.reply_count, False
	beside = reading.beside
	if listed is not None:
		assert threads is not None
		children, reply_count, older_hidden = _listed_replies(reading, threads, listed, fingerprint)
	elif not children and beside is not None and beside.reply_count is not None:
		# The redesign: the replies stand beside our row, and only LinkedIn's
		# own count makes a row beside it a reply to it. A comment that counts
		# none has none, whatever stands next to it.
		if not beside.counted:
			raise _drift(
				f"{len(beside.replies)} rows stand beside our comment and its reply count does not vouch for them",
				ours.element,
				fingerprint,
			)
		if beside.reply_count is not None and len(beside.replies) < beside.reply_count and not beside.older_hidden:
			raise _drift(
				f"our comment counts {beside.reply_count} replies and {len(beside.replies)} rows stand beside it",
				ours.element,
				fingerprint,
			)
		children, reply_count, older_hidden = beside.replies, beside.reply_count, beside.older_hidden
	# A reply a notification about OUR comment names is a reply to it wherever
	# the redesign lays it out — unless the page nests it under another row.
	vouched = {comment_id(urn) for urn in vouched_reply_urns} - {None}
	children = [
		*children,
		*(
			row
			for row in reading.page.rows.values()
			if row.id in vouched
			and row is not ours
			and row not in children
			and reading.page.parent_row(row) in (None, ours)
			# Never one the page's own data lists in another thread.
			and (threads is None or threads.thread_of.get(row.id) in (None, ours.id))
		),
	]
	own_author = _author(reading.page, ours, fingerprint)
	result["comment"] = {
		"present": True,
		"urn": reading.comment_urn,
		"resolvedId": ours.urn,
		"authorIsSelf": own_author[0] == own_profile_id,
		"textHash": text_hash(_body_text(reading.page, ours, fingerprint)),
		# What the page says, beside what was read: a reply missing from this
		# read proves a deletion only where LinkedIn's own count agrees with
		# the rows found. Replies in a shape no rule here recognises read as
		# none at all, and no count beside them is what says so. Where the
		# page's own data lists the thread, its count is the replies listed.
		"replyCount": reply_count,
		"replyRows": len(children),
		"repliesFrom": "page_data" if listed is not None else "markup",
	}
	reactions = reaction_count(reading.page, ours)
	if reactions is not None:
		result["comment"]["reactionCount"] = reactions
	if not result["comment"]["authorIsSelf"]:
		# A third-party root is ours to observe only while our confirmed room
		# reply is directly in it. A caller's boolean could never prove that.
		room_id = comment_id(room_reply_urn) if room_reply_urn else None
		if not room_id or not any(child.id == room_id and
			_author(reading.page, child, fingerprint)[0] == own_profile_id for child in children):
			return result

	replies: list[dict[str, Any]] = []
	for child in children:
		profile_id, profile_url, display_name = _author(reading.page, child, fingerprint)
		text = _body_text(reading.page, child, fingerprint)
		posted_at = snowflake_id_ms(child.id)
		if since_ms is not None and posted_at is not None and posted_at < since_ms:
			continue
		reply: dict[str, Any] = {
			"replyUrn": child.urn,
			"author": {
				"profileId": profile_id,
				**({"displayName": display_name} if display_name else {}),
				"profileUrl": profile_url,
				"isSelf": profile_id == own_profile_id,
			},
			"text": text,
			"textHash": text_hash(text),
			"observedAt": observed_at,
			"isDirectChild": True,
		}
		if posted_at is not None:
			reply["postedAt"] = posted_at
		replies.append(reply)
	# Chronological, so `limit` keeps the newest; a reply whose id carries no
	# time sorts as the newest of all.
	replies.sort(key=lambda reply: reply.get("postedAt", float("inf")))
	result["replies"] = replies[-limit:]
	# Older replies behind their own control are unread: an absence among
	# them proves nothing, as one past `limit` does not.
	result["truncated"] = len(replies) > limit or older_hidden
	return result


def _listed_replies(
	reading: ThreadReading, threads: PageThreads, listed: list[str], fingerprint: str
) -> tuple[list[_Row], int, bool]:
	"""Our replies as the page's own data lists them, each read by its own row,
	with any the markup nests under ours: the rows, how many the data lists,
	and whether the read is short of them — a listed reply whose row did not
	render, older replies behind their control, or a row beside ours the data
	lists nowhere, which says the data is not the whole page: a reply loaded
	after it would read as missing. A row the data and the markup place under
	two different comments is drift."""
	ours = reading.ours
	assert ours is not None
	rows: list[_Row] = []
	unrendered = False
	for urn in listed:
		row = reading.page.rows.get(comment_id(urn) or "")
		if row is None:
			unrendered = True
		elif reading.page.parent_row(row) not in (None, ours):
			raise _drift("a reply listed under ours is nested under another comment", row.element, fingerprint)
		else:
			rows.append(row)
	for child in reading.children:
		if child in rows:
			continue
		if threads.thread_of.get(child.id) not in (None, ours.id):
			raise _drift("a reply nested under ours is listed in another thread", child.element, fingerprint)
		rows.append(child)
	beside = reading.beside.replies if reading.beside is not None else []
	unlisted = any(row.id not in threads.thread_of for row in beside)
	return rows, len(listed), unrendered or unlisted or threads.older_hidden(reading.comment_urn)


def _author(page: _Page, row: _Row, fingerprint: str) -> tuple[str, str, str | None]:
	"""(profile id, profile url, display name) of the one person the row's own
	links name outside its body — the avatar and the name are two links to one
	profile. Nobody, or two different people, is drift."""
	links = [element for element in page.outside_body(row) if element.tag == "a" and profile_identity(element.get("href"))]
	identities = {profile_identity(link.get("href")) for link in links}
	if len(identities) != 1:
		raise _drift(f"a comment row names {len(identities)} authors", row.element, fingerprint)
	profile_id, profile_url = next(iter(identities))  # type: ignore[misc]
	name = next((lines[0] for lines in (link.lines() for link in links) if lines), None)
	return profile_id, profile_url, name[:MAX_DISPLAY_NAME] if name else None


def _body_text(page: _Page, row: _Row, fingerprint: str) -> str:
	bodies = [element for element in page.own_region(row) if is_body(element)]
	outermost = [body for body in bodies if not any(other is not body and other.contains(body) for other in bodies)]
	if len(outermost) != 1:
		raise _drift(f"a comment row has {len(outermost)} bodies", row.element, fingerprint)
	text = _SEE_MORE_RE.sub("", outermost[0].text()).strip()
	if not text or utf16_len(text) > MAX_REPLY_TEXT:
		raise _drift("a comment body is empty or longer than any comment", row.element, fingerprint)
	return text


def _drift(message: str, at: Element, fingerprint: str) -> SidecarError:
	return SidecarError(
		"UI_DRIFT",
		f"the post page's comment structure was not recognised: {message}",
		detail={"pageFingerprint": fingerprint, "selectorPack": SELECTOR_PACK_VERSION, "excerpt": redacted_excerpt(at)},
	)


def _structural_token(element: Element) -> str:
	token = element.tag
	for name in ("data-testid", "role"):
		value = element.get(name)
		if value:
			token += f"[{name}={value}]"
	key = element.get("componentkey")
	if key:
		token += f"[componentkey={re.match(r'[A-Za-z-]*', key).group(0)}]"  # type: ignore[union-attr]
	return token


def page_fingerprint(root: Element) -> str:
	"""A hash of the page's SHAPE — the tags, test ids, roles and component kinds
	it is built from, with no text, link or urn in it. Two reads of one layout
	agree; a layout change moves it."""
	tokens = sorted({_structural_token(element) for element in root.iter() if element is not root})
	return hashlib.sha256("\n".join(tokens).encode()).hexdigest()[:16]


def redacted_excerpt(at: Element) -> str:
	"""The structure around a failure with every word and identifier taken out:
	text becomes its length, a link the kind of page it points at. Enough to see
	what the selector pack missed, and nothing anyone wrote."""
	out: list[str] = []
	size = 0
	stack: list[tuple[Element | str, int] | str] = [(at, 0)]
	while stack and size < EXCERPT_CHARS:
		item = stack.pop()
		if isinstance(item, str):
			piece = item
		else:
			node, depth = item
			if isinstance(node, str):
				piece = f"#text({len(node.strip())})" if node.strip() else ""
			elif node.tag in _SILENT_TAGS or depth > 24:
				piece = ""
			else:
				attrs = _structural_token(node)[len(node.tag):]
				if node.get("href") is not None:
					kind = re.match(r"/(in|company|feed)/", urlparse(node.get("href") or "").path)
					attrs += f"[href=/{kind.group(1)}/…]" if kind else "[href=…]"
				piece = f"<{node.tag}{attrs}>"
				stack.append(f"</{node.tag}>")
				stack.extend((child, depth + 1) for child in reversed(node.children))
		out.append(piece)
		size += len(piece)
	return "".join(out)[:EXCERPT_CHARS]


# The page-side half of `Element.words` and of a control's labels, as a prefix
# for the invitation page scripts: every text node, a space between each, icons
# and scripts unread, and the control's `aria-label` beside it.
LABELS_JS = r"""
  const clean = value => (value || '').replace(/\s+/g, ' ').trim();
  const words = element => {
    const parts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement.closest('svg, script, style, template, noscript')) parts.push(node.nodeValue);
    }
    return clean(parts.join(' '));
  };
  const labels = element => [words(element), clean(element.getAttribute('aria-label'))].filter(Boolean);
"""


# Presses the first replies control under our row and nowhere else — not under a
# nested reply, not inside a body — by the row keys, body markers and label
# pattern the parser reads, passed in as arguments.
EXPAND_REPLIES_JS = r"""(commentId, rowPrefix, bodyTestId, bodyClasses, pattern) => {
  const clean = value => (value || '').replace(/\s+/g, ' ').trim();
  const idOf = element => {
    const key = element.getAttribute('componentkey') || '';
    const dataId = element.getAttribute('data-id') || '';
    const source = key.startsWith(rowPrefix) ? key.slice(rowPrefix.length) : (dataId.includes('urn:li:comment') ? dataId : '');
    const match = source.match(/^urn:li:comment:\((?:urn:li:)?(?:activity|ugcPost|share):[A-Za-z0-9_-]+,([A-Za-z0-9_-]+)\)$|^urn:li:comment:([A-Za-z0-9_-]+)$/);
    return match ? (match[1] || match[2]) : null;
  };
  // Every text node, a space between each, icons and scripts unread: the
  // parser's `words()`.
  const words = element => {
    const parts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement.closest('svg, script, style, template, noscript')) parts.push(node.nodeValue);
    }
    return clean(parts.join(' '));
  };
  const isBody = element => element.getAttribute('data-testid') === bodyTestId
    || bodyClasses.some(name => element.classList.contains(name));
  const expander = new RegExp(pattern, 'i');
  const rows = [...document.querySelectorAll(`[componentkey^="${rowPrefix}"], [data-id*="urn:li:comment"]`)]
    .filter(row => idOf(row) === commentId);
  if (!rows.length) return JSON.stringify({state: 'missing'});
  const candidates = [];
  for (const row of rows) {
    for (const button of row.querySelectorAll('button')) {
      let owner = null;
      let inBody = false;
      for (let node = button.parentElement; node; node = node.parentElement) {
        if (isBody(node)) inBody = true;
        owner = idOf(node);
        if (owner) break;
      }
      if (owner !== commentId || inBody || button.getAttribute('aria-expanded') === 'true') continue;
      const label = words(button) || clean(button.getAttribute('aria-label'));
      if (expander.test(label) && !candidates.includes(button)) candidates.push(button);
    }
  }
  if (!candidates.length) return JSON.stringify({state: 'none'});
  candidates[0].click();
  return JSON.stringify({state: 'clicked'});
}"""


def expand_replies_args(comment_urn: str) -> list[Any]:
	return [comment_id(comment_urn), REDESIGN_ROW_PREFIX, BODY_TEST_ID, list(LEGACY_BODY_CLASSES), REPLY_EXPANDER_PATTERN]
