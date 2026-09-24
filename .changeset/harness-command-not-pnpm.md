---
"mikoshi-construct": minor
---

templates: `AGENTS.md` and `.github/workflows/ci.yml` name the recorded harness command instead of a literal `pnpm run quality`, and the workflow's quality step quotes a command that would not parse as a bare YAML scalar (one carrying `: ` or ` #`), so its `run` is the command verbatim; with `pnpm run quality` the output is unchanged byte for byte. `construct doctor` checks a `pnpm`/`npm`/`yarn`/`bun` script command against `package.json` as before, and reports any other command — `make check`, say — as `harness.state: "unknown"`, named in the output as not statically checkable, rather than as a missing `package.json`; `doctor --json` gains the `harness` field, and `unknown` never makes `ok` false.
