---
"mikoshi-construct": patch
---

The bus agent has one source: `pnpm bus:agent` renders `dev.mikoshi.bus.plist` from its template with the factory directory and the command that prints the GitHub token, taken from `--factory-dir` and `--token-source` or from `CONSTRUCT_FACTORY_DIR` and `CONSTRUCT_BUS_TOKEN_SOURCE`, and prints a diff against the installed file. Nothing is written without `--apply`, which replaces the file and reloads the agent; a missing value refuses. The agent no longer reads `CONSTRUCT_FACTORY_DIR` from `launchctl setenv`, and it does not start when the token source fails.
