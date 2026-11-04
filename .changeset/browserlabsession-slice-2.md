---
"mikoshi-construct": patch
---

The bus installs the browser lab's playwright-core and Chromium before a session starts, so a session never needs the registry, and the witness node starts the server a browser witness needs from the serve field of construct.json, waits for its url, runs the witness and stops it; a browser witness on a local URL in a repository with no serve refuses instead of falling.
