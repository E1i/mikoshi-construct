---
"mikoshi-construct": minor
---

cli: discovery resolves a non-relative import through the repository's own configuration — the `paths` of the nearest `tsconfig.json` or `jsconfig.json` (with `baseUrl` and relative `extends`), and the workspace packages `pnpm-workspace.yaml` or the `workspaces` of `package.json` list (their `exports`, `module`, `main`, then the directory). A cross-package or aliased import becomes a relation in the Engram; a specifier no configuration names, such as an npm dependency, is still left out.
