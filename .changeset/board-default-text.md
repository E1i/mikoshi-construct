---
'mikoshi-construct': patch
---

`pnpm board` with no flag prints a short text reading of the bus — the release progress, the owner's waits, the cards by stage, the live backlog by lane and the services — instead of the HTML page, which on the stored bus was 8.7 MB against 8 KB for the text; a stopped bus prints its stop line, the snapshot age and the waits as text. The page now prints only under `--html`; `--json` and `--plan` print what they did.
