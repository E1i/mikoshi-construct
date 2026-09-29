---
'mikoshi-construct': minor
---

templates: the ladder script is now `scripts/construct/implement.workflow`, with no `.mjs`. What to do: in a repository made by `init`, run `construct sync --apply`. It removes `scripts/construct/implement.workflow.mjs` when its bytes are still what was recorded and writes the new path; sync reports this as the new class `moved`, and `--json` lists it under `retired`. If you edited the old file, sync writes neither path and reports both as `conflict`; move your edits across by hand. In an attached repository, run `construct detach`, then `construct attach`. Why: the script ends with a top-level `return`, the format the Workflow runtime runs, and a repository whose harness is `eslint .` parsed the `.mjs` and went red on its first check after attach. ESLint does not lint a file without a JavaScript extension, so the generated `eslint.config.mjs` no longer needs, and no longer carries, the `scripts/construct/*.workflow.mjs` ignore.
