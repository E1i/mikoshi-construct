---
'mikoshi-construct': minor
---

The factory and the window now reach the agent client through a Client Adapter, whose contract is in decision record 0060: spawning a session, its process, its identity and the readings of its stream and transcript go through the adapter, and `construct cost` reads session records through one registry of cost sources. Claude Code is the one adapter there is. What each session runs does not change, except what this release's other entries say.
