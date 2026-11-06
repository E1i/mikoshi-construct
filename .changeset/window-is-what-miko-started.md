---
'mikoshi-construct': patch
---

A window is now only a session `miko` started: `miko` for the loop, or the new `miko --tab` for a tab window. A bare `claude` or an IDE tab is no window: it writes no window heartbeat, and `handoff:write` and `miko:watch` refuse it and say how to start one. A prompt whose first line names the handoff of another repository is refused, naming the window it belongs to.
