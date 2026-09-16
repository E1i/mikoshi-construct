# mikoshi-construct

Bootstrap for AI-native software projects. Start with a proven engineering workflow instead of an
empty repository.

```
npx mikoshi-construct init
```

> **Status: v0.1 in progress.** Presets `node-backend`, `node-frontend`, `node-library` and
> `monorepo` work end to end; this repository runs on its own construct. Nothing is published to npm yet.

## What it does

`construct init` materializes a **construct** into a repository: architecture policy, an API contract,
a quality harness, and instructions for coding agents — then hands the repository to the agent for
discovery. The CLI detects facts; the agent interprets the system.

```
construct init
    ↓
Detect            Node, pnpm, monorepo, existing contract, existing rules
    ↓
Materialize       architecture/  contracts/  scripts/  .github/  .claude/  CLAUDE.md  AGENTS.md
    ↓
pnpm install && pnpm run quality      → green before you write a line
    ↓
claude → /construct-discover          the agent fills the discovery markers
    ↓
/plan → /implement                    the reasoning-budget ladder, verified by the harness
```

Three principles, in this order:

1. **CLI detects facts. Agent interprets the system.** Everything that requires understanding the
   codebase is a discovery marker the agent fills, never something the CLI guesses.
2. **Reasoning is a budget; verification decides when to spend more.** Implementation starts at low
   effort under strict constraints. The harness proves the result. Effort escalates only when the
   harness fails repeatedly or the task is ambiguous — *we don't pay for reasoning until the system
   demonstrates that we need it.*
3. **An artifact nobody validates against is just another README.** Contracts are validated at
   runtime, composition models render the diagrams, dependency policy lives in lint, and every
   security invariant names its check.

## Commands

| Command | What it does |
|---|---|
| `construct init` | Detect, configure, materialize. `--yes --preset node-backend\|node-frontend\|node-library\|monorepo --ai claude\|cursor\|both --review claude --dir . --dry-run` |
| `construct doctor` | Baseline files present, harness intact, discovery markers filled — `GLITCH` by name when not |
| `construct soulkill` | Print what the detector sees, write nothing (`--json`; aliases `inspect`, `capture`) |
| `construct cost` | Token usage of the `/implement` runs in this directory — the evidence behind "we don't pay for reasoning until we need it" (`--last`, `--json`) |

`--plain` turns off colours and lore for CI. `--johnny` — wake up, Netrunner.

> If you already keep a user-level `implement` skill in `~/.claude/skills/`, it shadows the one the
> construct puts in `.claude/skills/implement/`; move yours aside to run the repository's ladder.

## What lands in the repository

- `architecture/principles.md` — architecture, security and reasoning-budget rules (stack-agnostic)
- `architecture/security-invariants.md` — `Invariant | Enforced by`, extended by discovery
- `architecture/composition/*.yaml` — composition models; diagrams are rendered from them and checked
- `contracts/api/openapi.yaml` — the HTTP contract; types are generated from it, breaking changes flagged in CI
- `scripts/composition`, `scripts/contracts` — the harness pieces behind `pnpm run quality`
- `.github/workflows` — CI (the harness), secret scanning, dependency audit, contract diff, AI review
- `.claude/` — `architect`, `implementer` and `harness` agents, the `/implement` ladder, `/plan`, `/construct-discover`, rules
- `CLAUDE.md`, `AGENTS.md` — repository-specific context with discovery markers
- `construct.json` — the manifest: preset, harness command, contract paths, file hashes, marker locations

## Development

```
pnpm install
pnpm dev init --yes --preset node-backend --dir /tmp/demo
pnpm run quality
```

## License

MIT
