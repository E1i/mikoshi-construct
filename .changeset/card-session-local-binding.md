---
"mikoshi-construct": patch
---

factory: every card session (the launch, the resume after a refusal, and the answer session) may now bind a port on localhost, so a repository whose `pnpm run quality` runs tests that listen on a local port no longer stops the card with `listen EPERM`. No host is added to what the session may reach, and a command still never runs outside the sandbox.
