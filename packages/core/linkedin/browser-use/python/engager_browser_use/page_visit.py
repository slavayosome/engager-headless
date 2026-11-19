"""The page a write goes from: the one a person would be on, as that page names itself.

LinkedIn's own client makes a write from the page the person has open, and
LinkedIn sees both: the page view, then the API call, carrying the page's own
identity — `x-li-page-instance` (the page, as `urn:li:page:<page>;<view id>`),
`x-li-track` (the client) and `x-li-lang`. A write the sidecar makes through
LinkedIn's API is made the same way (`BrowserUseBackend._on_page`): the
standing tab is on the natural page for it — opened as any page view is,
or kept where it already is — and the request carries the headers that page's
own requests went out with, read off the browser's network events
(`PageIdentity`), never made up.

The redesigned pages host LinkedIn's API client in a preload frame
(`/preload/`) whose own requests name the frame's shell
(`urn:li:page:d_flagship3_preload`); the requests it makes for the page name
the page (`d_flagship3_profile_view_base` on a profile, read live
2026-10-20). Only those name the page a write is made from.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from .conversations import PAGE_HEADERS

# The page instance of the frame LinkedIn's client runs in on a redesigned
# page: its own requests, never the page's.
SHELL_PAGE_PREFIX = "urn:li:page:d_flagship3_preload"
_API_RE = re.compile(r"^https://(?:www\.)?linkedin\.com/voyager/api/")
_RSC_RE = re.compile(r"^https://(?:www\.)?linkedin\.com/flagship-web/rsc-action/")
# What a server-driven page's own requests name the page and the client by, as
# captured on the comments activity pager's request (2026-10-29).
RSC_HEADERS = (
	"x-li-application-version",
	"x-li-page-instance",
	"x-li-page-instance-tracking-id",
	"x-li-track",
	"x-li-anchor-page-key",
	"x-li-pageforestid",
	"x-li-application-instance",
)


@dataclass(frozen=True)
class PageVisit:
	"""One view of a page the standing tab made, in one browser session: the
	address it opened, the document LinkedIn served for it where it was kept,
	and when it began (a monotonic time) — what the page's own client named
	it by is what it sent after that (`PageIdentity.since`)."""

	url: str
	session_id: str
	document: str | None
	opened_at: float


def same_page(current: str, url: str) -> bool:
	"""Whether the tab at `current` is on the page `url` opens: LinkedIn's
	host, the same path, case and a trailing slash aside — a query or a
	fragment is not another page."""
	here, there = urlparse(current), urlparse(url)
	hosts = {"linkedin.com", "www.linkedin.com"}
	return (
		here.scheme == "https"
		and here.hostname in hosts
		and there.hostname in hosts
		and here.path.rstrip("/").casefold() == there.path.rstrip("/").casefold()
	)


class PageIdentity:
	"""The headers the open page's own client last named the page by: the
	newest request to LinkedIn's API carrying a page instance that is not the
	preload shell's, and when it went out (a monotonic time)."""

	def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
		self._clock = clock
		self.headers: dict[str, str] = {}
		self.seen_at: float | None = None

	def on_request(self, event: Any) -> None:
		request = event.get("request") if isinstance(event, dict) else None
		if not isinstance(request, dict) or not _API_RE.match(str(request.get("url") or "")):
			return
		raw = request.get("headers")
		if not isinstance(raw, dict):
			return
		headers = {str(name).lower(): str(value) for name, value in raw.items()}
		instance = headers.get("x-li-page-instance", "")
		if not instance.startswith("urn:li:page:") or instance.startswith(SHELL_PAGE_PREFIX):
			return
		self.headers = {name: headers[name] for name in PAGE_HEADERS if name in headers}
		self.seen_at = self._clock()

	def since(self, at: float) -> dict[str, str] | None:
		"""The page's headers where its client sent them at or after `at`."""
		return dict(self.headers) if self.seen_at is not None and self.seen_at >= at else None


class RscPageHeaders:
	"""The headers the open page's own client sent on its newest request to
	LinkedIn's server-driven actions (`rsc-action`), as they went out. Per-request
	values (the trace) are not kept."""

	def __init__(self) -> None:
		self.headers: dict[str, str] = {}

	def on_request(self, event: Any) -> None:
		request = event.get("request") if isinstance(event, dict) else None
		if not isinstance(request, dict) or not _RSC_RE.match(str(request.get("url") or "")):
			return
		raw = request.get("headers")
		if not isinstance(raw, dict):
			return
		headers = {str(name).lower(): str(value) for name, value in raw.items()}
		if headers.get("x-li-page-instance", "").startswith("urn:li:page:"):
			self.headers = {name: headers[name] for name in RSC_HEADERS if name in headers}
