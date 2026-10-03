---
"mikoshi-construct": minor
---

templates: the commit guard `attach` installs refuses with exit 2 on everything but an explicit allow, so input that is not a JSON object or an error while checking a call no longer exits 1, on which Claude Code runs the `git commit` anyway
