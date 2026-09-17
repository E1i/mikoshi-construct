---
"mikoshi-construct": minor
---

cli: `doctor` reports an enforcement level instead of matching substrings. Five checks — `lint-policy`, `construct-tests`, `ci`, `hook`, `red-gate` — each return `{id, level, state, evidence}`, with `level` from `L0` (text, or a command nobody is obliged to run) to `L3` (CI), `state` one of `present`, `absent` or `unknown`, and evidence naming the file or key that was read. The report ends with one line naming the weakest link: the lowest level among the gates the repository claims. `--json` gains `warnings`, `checks` and `weakestLink` after the fields it already emitted, which keep their names and meaning; the exit code is unchanged, so a low level is information, not a failure.

`doctor` executes nothing from the repository it inspects — no child process, no dynamic import of a path inside it, no `require` into its `node_modules`, no call into its ESLint or Vitest APIs — because it is run through `npx` in a clone nobody has decided to trust yet, and a flat ESLint config is a module. The lint policy forbids those forms under `src/**` and `tests/dependency-policy.test.ts` lints one sample per form. Because branch protection lives in the GitHub API and not in a file, `doctor` never claims `L4`, `ci` is never `absent`, and the red gate is always `unknown` and says so.
