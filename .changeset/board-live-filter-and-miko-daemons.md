---
'mikoshi-construct': patch
---

cli: the board's LIVE filter now holds after a reload. The page sets the filter named by the anchor (`#show-live`) or the last stored view before its first render, so the highlighted tab and the list always agree. LIVE shows only running work and cards of the open release, so a backlog card held by an owner decision is left out of it. Every card that is not running shows its release and its blocker or hold reason in the HTML and text boards. The Miko panel shows its mode: HIJACK has a red chip and reads `breached <path>`, an own repository reads `own repo <path>`. It also has a DAEMONS cell that reads the daemons from the `daemon:` frontmatter of the skill manifests: one SD card per installed daemon, LOADED or asleep as observed in the window heartbeat's skills, and a status pane that follows the hovered card.
