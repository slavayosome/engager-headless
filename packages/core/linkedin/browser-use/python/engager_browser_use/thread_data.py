"""Which comment each comment answers, read from the post page's own data.

The redesigned post page is server-driven: the document LinkedIn serves for it
carries the data it renders from as React flight rows, in a `#rehydrate-data`
script declaring `window.__como_rehydration__` (read in the document response
2026-10-13). The page removes the script once it has rendered, and on a live
page neither it nor the global is left (probed 2026-10-13), so the data is
read from the navigation's own response (`script_from_document`) where the
page no longer holds it (`PAGE_DATA_JS`). Every comment in the list is an
item keyed by its urn (`semanticId`) with the thread line
LinkedIn draws for it: `threadlineDecoration.threadId` names the top-level
comment whose thread the item sits in. A top-level comment's thread is its
own; a reply's is the comment it answers. The markup renders replies flat,
beside the comment they answer, with nothing in it that says which one — the
data says it outright, and that is what this module reads.

A thread's "load previous replies" control is an item of its own,
`repliesSectionAnchor-<comment>-true`: where it is listed, older replies may
sit behind it, unloaded.

FAIL CLOSED. Data this module does not recognise — no payload, a row it
cannot parse, one comment listed in two threads, our comment not listed as a
thread of its own — is Unrecognised, and the caller reads the markup as it
did before this module existed: never "no replies". Where it lists our
thread, a reply it does not list is missing from that read as from any whole
read — a reply held from a notification included — and only a second such
read six hours on, our comment present, removes it (`replyWatches.ts`); a
row beside ours that it lists nowhere says the data is not the whole page,
and the read proves no absence at all (`replies._listed_replies`).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from .replies import comment_id

# The page's flight data, where the page still holds it: the rehydration array
# its runtime reads, else the text of the script that declares it. Every rule
# runs in `page_threads`.
PAGE_DATA_JS = r"""() => {
  const chunks = window.__como_rehydration__;
  if (Array.isArray(chunks) && chunks.every(chunk => typeof chunk === 'string')) {
    return JSON.stringify({flight: chunks.join('')});
  }
  const script = document.getElementById('rehydrate-data');
  return JSON.stringify({script: script ? script.textContent : null});
}"""

_SCRIPT_PREFIX_RE = re.compile(r"^\s*window\.__como_rehydration__\s*=\s*")
# The script tag that declares it, in a document that runs to megabytes:
# bounded, so a search never backtracks across the page.
_SCRIPT_TAG_RE = re.compile(r'<script\b[^>]{0,512}\bid="rehydrate-data"[^>]{0,512}>')
# One flight row's head: its id (empty on a hint row) and its tag, if any.
_ROW_RE = re.compile(rb"([0-9a-f]*):([A-Z]{0,2})")
# A text row's length in bytes, in hex, before its words.
_TEXT_LENGTH_RE = re.compile(rb"([0-9a-f]+),")
_OLDER_ANCHOR_RE = re.compile(r"^repliesSectionAnchor-(urn:li:comment:\(.+\))-true$")


class Unrecognised(ValueError):
	"""The page's data is not in a shape this module reads."""


@dataclass(frozen=True)
class PageThreads:
	"""Every comment the page's data lists, by comment id: its urn as minted,
	the id of the comment whose thread it sits in, and the threads with a
	control for older replies listed."""

	urns: dict[str, str]
	thread_of: dict[str, str]
	older: frozenset[str]

	def lists(self, comment_urn: str) -> bool:
		return comment_id(comment_urn) in self.thread_of

	def replies_to(self, comment_urn: str) -> list[str] | None:
		"""The urns of the replies listed in our comment's thread, in the order
		listed — or None where our comment is not listed as a thread of its own,
		which says nothing about its replies."""
		ours = comment_id(comment_urn)
		if ours is None or self.thread_of.get(ours) != ours:
			return None
		return [self.urns[key] for key, thread in self.thread_of.items() if thread == ours and key != ours]

	def older_hidden(self, comment_urn: str) -> bool:
		return comment_id(comment_urn) in self.older


def script_from_document(html: str) -> str:
	"""The `#rehydrate-data` script's text in the document LinkedIn served for
	the page, or Unrecognised. Only the tag is matched — the document is never
	parsed as a page — and the script runs to the first `</script>` after it."""
	tag = _SCRIPT_TAG_RE.search(html)
	if tag is None:
		raise Unrecognised("the document declares no rehydration data")
	end = html.find("</script>", tag.end())
	if end < 0:
		raise Unrecognised("the document's rehydration script never closes")
	return html[tag.end():end]


def flight_from_page(raw: Any) -> str:
	"""The flight text PAGE_DATA_JS found, or Unrecognised."""
	if isinstance(raw, dict) and isinstance(raw.get("flight"), str):
		return raw["flight"]
	script = raw.get("script") if isinstance(raw, dict) else None
	if not isinstance(script, str):
		raise Unrecognised("the page carries no rehydration data")
	prefix = _SCRIPT_PREFIX_RE.match(script)
	if prefix is None:
		raise Unrecognised("the rehydration script declares something else")
	try:
		chunks = json.loads(script[prefix.end():].strip().removesuffix(";"))
	except json.JSONDecodeError as exc:
		raise Unrecognised("the rehydration script is not a list of chunks") from exc
	if not isinstance(chunks, list) or not all(isinstance(chunk, str) for chunk in chunks):
		raise Unrecognised("the rehydration script is not a list of chunks")
	return "".join(chunks)


def flight_values(flight: str, *, text_rows: list[bytes] | None = None) -> list[Any]:
	"""Every JSON value the flight rows carry, in stream order. A text row
	(`T<hex length>,`) carries words, not structure, and is stepped over by its
	length in bytes — handed to `text_rows` where the caller wants them, as the
	bytes they are; any row that does not parse is Unrecognised."""
	data = flight.encode("utf-8")
	values: list[Any] = []
	position = 0
	while position < len(data):
		head = _ROW_RE.match(data, position)
		if head is None:
			raise Unrecognised(f"no flight row begins at byte {position}")
		position = head.end()
		if head.group(2) == b"T":
			length = _TEXT_LENGTH_RE.match(data, position)
			if length is None:
				raise Unrecognised(f"the text row at byte {position} carries no length")
			words = length.end()
			position = words + int(length.group(1), 16)
			if text_rows is not None:
				text_rows.append(data[words:position])
			continue
		end = data.find(b"\n", position)
		end = len(data) if end < 0 else end
		try:
			values.append(json.loads(data[position:end]))
		except json.JSONDecodeError as exc:
			raise Unrecognised(f"a flight row at byte {position} is not JSON") from exc
		position = end + 1
	return values


def state_name(key: Any) -> str | None:
	"""The name a model state is declared under. LinkedIn carried it as the
	state key's own `value` (read 2026-10-14) and now leaves that empty and
	names the state in a nested key, `key.value.id` (read 2026-11-12); a key
	naming it neither way names nothing."""
	if not isinstance(key, dict):
		return None
	if isinstance(name := key.get("value"), str) and name:
		return name
	inner = key.get("key")
	named = inner.get("value") if isinstance(inner, dict) else None
	if isinstance(named, dict) and named.get("$case") == "id" and isinstance(name := named.get("id"), str) and name:
		return name
	return None


def page_threads(raw: Any) -> PageThreads:
	"""The threads the page's data lists, or Unrecognised."""
	urns: dict[str, str] = {}
	thread_of: dict[str, str] = {}
	older: set[str] = set()
	for item in _list_items(flight_values(flight_from_page(raw))):
		semantic = item.get("semanticId")
		if not isinstance(semantic, str):
			continue
		anchor = _OLDER_ANCHOR_RE.fullmatch(semantic)
		if anchor is not None and (key := comment_id(anchor.group(1))) is not None:
			older.add(key)
			continue
		key = comment_id(semantic)
		decoration = item.get("threadlineDecoration")
		thread_urn = decoration.get("threadId") if isinstance(decoration, dict) else None
		thread = comment_id(thread_urn) if isinstance(thread_urn, str) else None
		if key is None or thread is None:
			continue
		if thread_of.setdefault(key, thread) != thread:
			raise Unrecognised("one comment is listed in two threads")
		urns.setdefault(key, semantic)
	return PageThreads(urns=urns, thread_of=thread_of, older=frozenset(older))


def _list_items(values: list[Any]) -> list[dict[str, Any]]:
	"""Every list item in the data — an object carrying both a semantic id and
	a thread line — in document order."""
	items: list[dict[str, Any]] = []
	stack: list[Any] = list(reversed(values))
	while stack:
		value = stack.pop()
		if isinstance(value, dict):
			if "semanticId" in value and "threadlineDecoration" in value:
				items.append(value)
			stack.extend(reversed(list(value.values())))
		elif isinstance(value, list):
			stack.extend(reversed(value))
	return items
