---
'mikoshi-construct': patch
---

The law registry stops counting a review session as witnessed alive when the supervisor ends it on one stale signal. The Z7 × review cell of `scripts/nodes/laws.ts` is now a gap closed by #1792, review-stall-is-not-a-silent-loop: `StalledSessions` sends SIGTERM to a review session whose context did not grow for eight minutes, so a long reasoning step with no tool call reads as death. The registry gains the `supervisor` site, `scripts/supervisor/stalled-sessions.ts`, with a cell for every law; its Z7 cell is the same gap. A gap cell now counts as passing only when its witness calls a function of the site's own module, so a witness that only reads the bus no longer strikes it. `contract/factory.json` records the new site and cells, and `contract/ratchet.json` records three new gap rows: Z2 × supervisor, Z7 × review and Z7 × supervisor.
