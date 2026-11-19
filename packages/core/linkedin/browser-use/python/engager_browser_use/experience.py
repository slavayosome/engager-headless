"""THE CURRENT ROLE, AS THE MEMBER'S OWN PAGES SHOW IT.

LinkedIn's profile lookup carries no positions, and the profile page draws its
Experience card only for a reader who scrolls to it. So the role is read where
a person reads it: the member's experience page (`/in/<slug>/details/experience/`),
whose first entry still running names the title, the company and the company
page it links. That link is the page's numeric id; `read_company_page` follows
it to the page it names.

Where that entry links no page — a company with none — the company pages the
member's recent activity links are looked through for one of the same name.
That is a guess by name and nothing more: the same name, the first that
matches, or no page at all. Nothing is searched for and nothing is pressed.

Pure rules over what `EXPERIENCE_JS` and `TRACES_JS` hand back; `backend.py`
does the navigating. Every string is LinkedIn's text, held as data.
"""

from __future__ import annotations

import re
from typing import Any

from .voyager import COMPANY_NAME_MAX, COMPANY_REF_MAX, company_slug

# The experience page's entries, oldest last: each one's visible lines and the
# company page it links, where it links one.
EXPERIENCE_JS = r"""() => JSON.stringify([...document.querySelectorAll('[componentkey^="entity-collection-item"]')].slice(0, 12).map((item) => {
  const link = item.querySelector('a[href*="/company/"]');
  return {
    lines: (item.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 8).map((line) => line.slice(0, 300)),
    href: link ? link.getAttribute('href') : null,
  };
}))"""

# The company pages the profile's activity links, once its Experience
# placeholder has been scrolled to, by the name each link gives.
TRACES_JS = r"""() => JSON.stringify([...document.querySelectorAll('a[href*="/company/"][aria-label^="View company:"]')].slice(0, 30).map((link) => ({
  href: link.getAttribute('href'),
  name: (link.getAttribute('aria-label') || '').slice('View company:'.length).trim().slice(0, 300),
})))"""

SCROLL_TO_EXPERIENCE_JS = r"""() => {
  const card = document.querySelector('[id^="profileCardsExperience"]');
  if (card) card.scrollIntoView({ block: 'center' });
  return JSON.stringify(Boolean(card));
}"""

_RUNNING_RE = re.compile(r"\bPresent\b")
# "3 yrs 5 mos": the line under a company that holds several roles.
_SPAN_RE = re.compile(r"^\d+\s+(?:yrs?|mos?)\b")
_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")


def _text(value: Any) -> str | None:
	return value.strip()[:COMPANY_NAME_MAX] if isinstance(value, str) and value.strip() else None


def _named(lines: list[str]) -> tuple[str | None, str | None]:
	"""An entry's title and company. One role reads title, then "Company ·
	Full-time"; a company holding several reads the company, its span, then
	the newest role's title."""
	if len(lines) > 1 and _SPAN_RE.match(lines[1]):
		return (lines[2] if len(lines) > 2 else None), lines[0]
	company = lines[1].split(" · ")[0].strip() if len(lines) > 1 else None
	# A role with no company line is followed at once by its dates.
	if company and (_RUNNING_RE.search(company) or _YEAR_RE.search(company)):
		company = None
	return (lines[0] if lines else None), company


def current_role(items: Any, traces: Any) -> dict[str, str] | None:
	"""The role the experience page shows as still running, newest first, or
	None where it shows none it can name."""
	if not isinstance(items, list):
		return None
	for item in items:
		lines = [line for line in item.get("lines") or [] if isinstance(line, str)] if isinstance(item, dict) else []
		if not any(_RUNNING_RE.search(line) for line in lines[:6]):
			continue
		title, company = (_text(part) for part in _named(lines))
		ref = company_slug(str(item.get("href") or ""))
		if ref is None and company:
			# No page linked: one their activity links under the same name.
			ref = next(
				(
					slug
					for trace in (traces if isinstance(traces, list) else [])
					if isinstance(trace, dict) and str(trace.get("name") or "").casefold() == company.casefold()
					for slug in [company_slug(str(trace.get("href") or ""))]
					if slug
				),
				None,
			)
		role = {
			**({"title": title} if title else {}),
			**({"company": company} if company else {}),
			**({"companyRef": ref} if ref and len(ref) <= COMPANY_REF_MAX else {}),
		}
		if "company" in role or "companyRef" in role:
			return role
	return None
