# Local LinkedIn connector

The agent runs a dedicated Chromium session on the owner's machine. Engager accesses it through the LinkedIn driver and the local Python sidecar. Use the browser installation and local startup check in the [headless installation guide](../../../..).

The sidecar tests use fake browser sessions. Run them from the repository root.

```sh
cd packages/core/linkedin/browser-use/python
uv run --locked python -m unittest discover -s tests
```
