<!-- construct:begin -->
# py-svc-assets

@AGENTS.md

Everything an agent needs to know about this repository — product, module map, commands, harness,
composition roots, dependency policy, high-effort areas, defects vs accepted variance — lives in
[AGENTS.md](AGENTS.md), imported above. Repository-wide code rules are in `.claude/rules/`; the
architecture, security and reasoning-budget rules in
[architecture/principles.md](architecture/principles.md).

## Working here with Claude Code

- `/construct-discover` — fill or refresh the discovery blocks in AGENTS.md and `architecture/`.
- `/plan <feature>` — decompose a feature into tasks with acceptance criteria and an effort class.
- `/implement <task>` — run the reasoning-budget ladder: classify, implement at the lowest rung,
  verify with `pnpm run quality`, escalate only when verification proves it was not enough.
- `construct doctor` (or `npx mikoshi-construct doctor`) — check that the baseline and discovery are
  intact.
<!-- construct:end -->
