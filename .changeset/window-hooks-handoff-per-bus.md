---
"mikoshi-construct": patch
---

The window hooks that `construct init` and `construct attach` write now read the handoff of their own repository, `~/.construct/<repo-id>/handoff/miko.md` beside that repository's bus, when neither `CONSTRUCT_HANDOFF` nor `CONSTRUCT_HANDOFF_DIR` names one. A session in one repository is no longer held at its stop by the `STATUS: CONTINUE` of another repository's handoff, and a repository with no handoff of its own never blocks a stop.
