---
"mikoshi-construct": patch
---

The browser lab names the sandbox when Chromium cannot start inside it, with the bare-command rule, instead of a ProcessSingleton line that reads as a profile fault. The browser-lab skill tells the agent to run the bare command from the repository root, with no `cd`, `env` prefix or `&&`.
