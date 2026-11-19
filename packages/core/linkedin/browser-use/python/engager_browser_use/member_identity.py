"""Member identity derived from a mini profile already present in a read."""

from __future__ import annotations

import re
from typing import Any

_MINI_PROFILE_RE = re.compile(r"urn:li:fs_miniProfile:([A-Za-z0-9_-]{1,200})")


def member_urn_from_mini_profile(profile: Any) -> str | None:
	if not isinstance(profile, dict):
		return None
	match = _MINI_PROFILE_RE.fullmatch(str(profile.get("entityUrn")))
	return f"urn:li:fsd_profile:{match.group(1)}" if match else None
