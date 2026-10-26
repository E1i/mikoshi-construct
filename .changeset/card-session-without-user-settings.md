---
"mikoshi-construct": minor
---

factory: every card session (the launch, the resume after a refusal, and the answer session) now starts with `--setting-sources project,local` beside its own `--settings`, so your `~/.claude/settings.json` is no longer loaded into it: an `allowWrite` or allow rule there no longer opens anything to the session. The repository's `.claude/settings.json` and `.claude/settings.local.json` still load, and managed settings still apply.
