---
"mikoshi-construct": minor
---

factory: every card session (the launch, the resume after a refusal, and the answer session) now starts with `--settings` carrying its own permissions: the sandbox on, with no way to start without it or to run a command outside it; allow rules for exactly the gate commands of the repository's `construct.json` and for edits inside the card tree, `.construct/report.md` included; the answer session also gets its one owner-question file. A card session in a foreign repository no longer depends on that repository's or your own `.claude/settings.json` for its permissions, and nothing in them is changed. The rules still merge with yours: an `allowWrite` in your `~/.claude/settings.json` also opens that path to the session's commands.
