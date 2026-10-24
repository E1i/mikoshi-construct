---
'mikoshi-construct': minor
---

New bin `construct-factory`: run in your repository, it starts the factory from the installed package — the bus, its switched-on workers and their supervisor, each as `node` on its built file and detached so it survives closing the terminal — and on macOS installs a per-user launchd agent that keeps it running for that repository; the factory's own checkout keeps its own agent and gets none.
