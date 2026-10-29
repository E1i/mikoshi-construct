---
"mikoshi-construct": patch
---

`construct attach` on a repository whose remote is not on GitHub now says plainly that the factory is unavailable there, and installs the window alone: without the harness, with no required check asked for, and with no factory place created beside it. A repository with no remote, or a remote that is a local path, attaches as before. `--harness none` attaches without a gate on purpose, and the refusal for a required check that cannot be resolved now names it as the other way forward. Gogs, Gitea and GitLab are not adapters yet.
