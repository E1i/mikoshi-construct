---
"mikoshi-construct": patch
---

An owner question no longer ends the window's turn: a tab window whose handoff ends `STATUS: OWNER` cannot stop without a live `pnpm miko:watch`, so the question waits on the board while the window keeps settling every other card.
