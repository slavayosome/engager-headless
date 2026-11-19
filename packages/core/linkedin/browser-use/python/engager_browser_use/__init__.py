"""Local LinkedIn Browser Use sidecar.

The package deliberately exposes Engager's small, versioned protocol rather
than Browser Use's broad MCP or Agent surfaces.
"""

from .protocol import PROTOCOL_VERSION, SELECTOR_PACK_VERSION, SIDECAR_VERSION

__all__ = ["PROTOCOL_VERSION", "SELECTOR_PACK_VERSION", "SIDECAR_VERSION"]
