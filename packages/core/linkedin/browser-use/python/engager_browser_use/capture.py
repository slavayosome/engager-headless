"""The JSON a page load fetched for itself, kept as the page received it.

LinkedIn's pages fetch their own data as JSON: an ordinary load fetches the
account's notification cards, and the messaging page its conversation list. A
reader that needs that data keeps the responses the page itself received —
read off the browser's own network events for the page's target:
`responseReceived` names a response, `loadingFinished` says its body is
whole, `getResponseBody` hands that body over. Nothing is requested that the
page did not request.

A response is kept by its address alone, and only one the page fetched as an
XHR or a fetch. No content type is assumed: LinkedIn serves JSON as
`application/vnd.linkedin.normalized+json+2.1` and as `application/graphql`,
and a body that does not parse is handed over as None — what it means is the
reader's to judge, never this module's.

A load can keep more than the response it waits on: one that matches an
`also` pattern is kept where it finished first, and never waited on — the
account's own `/voyager/api/me`, which the same load fetches early.

A kept response carries the headers the page's own request went out with
(`requestWillBeSent`), so a read the page makes for the sidecar can carry them
too. The tap also hands every request address the page makes to `learn` — how
the sidecar keeps up with the addresses LinkedIn's own client uses — and every
request to `observe`, which keeps the headers the page names itself by
(`page_visit.PageIdentity`).

A capture can keep the navigation's own DOCUMENT instead (`types`): the post
page's server-driven data arrives in the document LinkedIn serves and is gone
from the page once it has rendered, so the response is the one place it can
be read. Its body is handed over as text (`response_text`), never parsed here.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

# The resource types a page's own data arrives as.
_DATA_TYPES = frozenset({"XHR", "Fetch"})
# The resource type a navigation's own response arrives as.
DOCUMENT_TYPES = frozenset({"Document"})


@dataclass(frozen=True)
class CapturedResponse:
	url: str
	# The parsed JSON, or None where the body is not JSON.
	body: Any
	# The headers the page's own request carried, names lowercased; empty
	# where the browser reported none.
	request_headers: Mapping[str, str] = field(default_factory=dict)


@dataclass
class ResponseCapture:
	"""The responses one page load is waiting to keep: those of `types` on the
	page target's session whose address matches `pattern` or one of `also`, in
	the order the page received them. Only `pattern` is waited on."""

	session_id: str
	pattern: re.Pattern[str]
	also: tuple[re.Pattern[str], ...] = ()
	types: frozenset[str] = _DATA_TYPES
	received: dict[str, str] = field(default_factory=dict)
	finished: list[str] = field(default_factory=list)
	first_finished: asyncio.Event = field(default_factory=asyncio.Event)
	# The request headers of each matching request, by request id.
	headers: dict[str, dict[str, str]] = field(default_factory=dict)
	# The ids of the requests to `pattern` the page began to send, whether or not
	# anything has answered yet.
	requested: list[str] = field(default_factory=list)
	# The bytes each finished response came to over the wire, by request id.
	sizes: dict[str, int] = field(default_factory=dict)

	def keeps(self, url: str) -> bool:
		return any(pattern.search(url) for pattern in (self.pattern, *self.also))

	def on_request(self, event: Any, session_id: str | None) -> None:
		request = event.get("request") or {}
		request_id = event.get("requestId")
		url = str(request.get("url") or "")
		if (
			session_id == self.session_id
			and isinstance(request_id, str)
			and self.pattern.search(url)
			and request_id not in self.requested
		):
			self.requested.append(request_id)
		if (
			session_id == self.session_id
			and isinstance(request_id, str)
			and self.keeps(url)
			and isinstance(request.get("headers"), dict)
		):
			self.headers[request_id] = {
				str(name).lower(): str(value) for name, value in request["headers"].items()
			}

	def on_received(self, event: Any, session_id: str | None) -> None:
		if session_id != self.session_id or event.get("type") not in self.types:
			return
		url = str((event.get("response") or {}).get("url") or "")
		request_id = event.get("requestId")
		if isinstance(request_id, str) and self.keeps(url):
			self.received[request_id] = url

	def on_finished(self, event: Any, session_id: str | None) -> None:
		request_id = event.get("requestId")
		if session_id == self.session_id and request_id in self.received and request_id not in self.finished:
			self.finished.append(request_id)
			size = event.get("encodedDataLength")
			if isinstance(size, (int, float)) and not isinstance(size, bool):
				self.sizes[request_id] = int(size)
			if self.pattern.search(self.received[request_id]):
				self.first_finished.set()


class NetworkTap:
	"""The one handler a CDP client's registry holds for each network event a
	capture reads — its registry keeps one per event — handing each event to
	whichever capture is waiting. Attached once per client: a restarted
	browser is a new client."""

	def __init__(self) -> None:
		self.client: Any | None = None
		self.capture: ResponseCapture | None = None
		# Handed the address of every request the page makes, captured or not.
		self.learn: Callable[[str], None] | None = None
		# Handed every request the page makes, with the headers it went out with.
		self.observe: Callable[[Any], None] | None = None

	def attach(self, client: Any) -> None:
		if self.client is client:
			return
		client.register.Network.requestWillBeSent(self._requested)
		client.register.Network.responseReceived(self._received)
		client.register.Network.loadingFinished(self._finished)
		self.client = client

	def _requested(self, event: Any, session_id: str | None) -> None:
		if self.capture is not None:
			self.capture.on_request(event, session_id)
		url = (event.get("request") or {}).get("url")
		if self.learn is not None and isinstance(url, str):
			self.learn(url)
		if self.observe is not None:
			self.observe(event)

	def _received(self, event: Any, session_id: str | None) -> None:
		if self.capture is not None:
			self.capture.on_received(event, session_id)

	def _finished(self, event: Any, session_id: str | None) -> None:
		if self.capture is not None:
			self.capture.on_finished(event, session_id)


async def response_text(client: Any, session_id: str, request_id: str) -> str:
	"""One finished response's body as text."""
	response = await client.send.Network.getResponseBody(params={"requestId": request_id}, session_id=session_id)
	raw = response.get("body") or ""
	if response.get("base64Encoded"):
		raw = base64.b64decode(raw).decode("utf-8", errors="replace")
	return raw


async def response_json(client: Any, session_id: str, request_id: str) -> Any:
	"""One finished response's body as JSON, or None where it is not JSON."""
	try:
		return json.loads(await response_text(client, session_id, request_id))
	except json.JSONDecodeError:
		return None
