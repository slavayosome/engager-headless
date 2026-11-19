"""Where the account's received invitations live.

The list is read from its page's own data (`invitations_data.py`); an Accept
is bound by the key that data names for its request (`invitation_accept.py`).
"""

from __future__ import annotations

INVITATIONS_URL = "https://www.linkedin.com/mynetwork/invitation-manager/received/"
INVITATIONS_PATH = "/mynetwork/invitation-manager"

MAX_DISPLAY_NAME = 200
