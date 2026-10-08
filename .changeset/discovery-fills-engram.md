---
"mikoshi-construct": minor
---

model: `construct.model.json` moves to `modelVersion` 5 with an optional `mechanics` block — what discovery found in a repository's code without an LLM: the commit (`git rev-parse HEAD` and its exit code), the tracked tree (`git ls-files -z`), every tracked TypeScript or JavaScript file as a component, and each relative import and each call of an imported name as a relation with the file and line it stands on. A component is never a node of the map and carries no state; an import that resolves to no tracked file, or a directory git does not hold, is recorded as `unknown` instead of guessed. The same repository at the same commit gives the same bytes. An attached repository's Engram is written to `~/.construct/engram/<repo>/construct.model.json`, so the attached tree stays untouched; a repository made by `init` keeps it in its own `construct.model.json`. A build older than this one reads a version 5 model as ahead of it.
