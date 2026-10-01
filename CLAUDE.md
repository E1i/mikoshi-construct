# mikoshi-construct

CLI that materializes a **construct** — architecture policy, API contract, quality harness and AI-agent
instructions — into a repository, then hands the repository to the agent for discovery. This repository
runs on its own construct (see the Construct block at the end and [AGENTS.md](AGENTS.md)); the `init`
flow is modelled in [architecture/composition/init.yaml](architecture/composition/init.yaml). Never copy
project-specific names, scopes, env vars or webhooks from any reference repository into templates.

@AGENTS.md

## Commands

```bash
pnpm dev init --yes --preset node-backend --dir /tmp/demo   # run the CLI from source
pnpm dev doctor --dir /tmp/demo
pnpm dev soulkill --dir /tmp/demo --json
pnpm run quality        # lint + typecheck + vitest — the gate for every change
pnpm build              # tsup → dist/cli.js (bin: construct, miko, mikoshi-construct)
```

Run the published CLI from outside this repository: `npx mikoshi-construct` here resolves the local
package, not the release. Keep the global `construct` current (`npm i -g mikoshi-construct@latest`):
a stale one reads a newer manifest as ahead of it, and its `cost` figures come from an older build.

Acceptance for any change touching `templates/` or `src/materialize`: an empty directory →
`construct init --yes --preset <preset>` → `pnpm install` → `pnpm run quality` is green, with no manual
edits. Run it before reporting done.

pnpm 12.4.2, the pinned `packageManager`, rejects `pnpm -s`; write `pnpm --silent` or `pnpm exec`.

## Layout

The module table and the layout notes are in [AGENTS.md § Layout](AGENTS.md#layout).

<!-- construct:begin -->
## Construct

This repository runs on a construct materialized by `mikoshi-construct` v0.1.0. The
discovery blocks — product, module map, commands, composition roots, dependency policy, high-effort
areas, defects vs accepted variance — live in [AGENTS.md](AGENTS.md), open questions in
[architecture/open-questions.md](architecture/open-questions.md); the
architecture, security and reasoning-budget rules in
[architecture/principles.md](architecture/principles.md); repository-wide code rules in
`.claude/rules/`.

- `/construct-discover` — fill or refresh the discovery blocks.
- `/plan <feature>` — decompose a feature into tasks with acceptance criteria and an effort class.
- `/implement <task>` — the reasoning-budget ladder: classify, implement at the lowest rung, verify
  with `pnpm run quality`, escalate only when verification proves it was not enough.
- `construct doctor` (or `npx mikoshi-construct doctor`) — check that the baseline and discovery are
  intact.
<!-- construct:end -->
