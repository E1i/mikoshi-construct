# mikoshi-construct

Bootstrap for AI-native software projects. Start with a proven engineering workflow instead of an
empty repository.

```
npx mikoshi-construct init
```

> **v0.1.** Presets `node-backend`, `node-frontend`, `node-library` and `monorepo`. Claude Code gets
> the full lifecycle; Cursor gets the rules, the conventions and the discovery protocol.

## What it does

`construct init` materializes a **construct** into a repository — architecture policy, an API
contract, a quality harness and instructions for coding agents — then hands the repository to the
agent for discovery. The CLI detects facts; the agent interprets the system.

```
construct init
    ↓
Detect            Node, pnpm, monorepo, existing contract, existing rules — facts only
    ↓
Materialize       architecture/  contracts/  scripts/  .github/  .claude/  AGENTS.md  construct.json
    ↓
pnpm install && pnpm run quality      → green before you write a line
    ↓
claude → /construct-discover          the agent fills ten discovery markers from the code
    ↓
/plan → /implement                    the reasoning-budget ladder, verified by the harness
```

An existing repository gets the policy, the harness tooling and the agent files, never example
code; its own `AGENTS.md`, `CLAUDE.md`, `package.json` and configs are merged or left alone, and
`init` says what still has to be wired by hand.

## Three principles

1. **CLI detects facts. Agent interprets the system.** Everything that needs understanding of the
   codebase — the module map, the composition roots, the high-effort areas, the security invariants —
   is a discovery marker the agent fills by reading code, never something the CLI guesses.
2. **Reasoning is a budget; verification decides when to spend more.** Implementation starts at low
   effort under strict constraints. The harness proves the result. Effort escalates only when the
   harness fails repeatedly or the task is ambiguous. *We don't pay for reasoning until the system
   demonstrates that we need it.*
3. **An artifact nobody validates against is just another README.** The contract is validated at
   runtime, composition models render the diagrams and are checked against the code, the dependency
   policy lives in lint, and every security invariant names the check that enforces it.

The second principle in numbers, from three `/implement` runs on the same small service (Claude
Opus): two tasks classified `high` — contract change, composition-root change — cost 1.7M and 1.4M
billable tokens with an architect design phase; the `low` task, docs only, cost 236k with none. The
harness passed every run on the first rung. `construct cost` prints this for your own runs.

## The lifecycle

**Discover** — `/construct-discover` reads the repository and fills `AGENTS.md` and `architecture/`:
what the product does and where a defect costs the most, the module map, the composition roots, the
dependency policy (and makes lint enforce it), the high-effort areas, one composition model per real
flow, the security invariants with their checks, what a reviewer must flag, and what looks like a
convention but is not. Where a section already exists in the repository, the marker points at it.

**Plan** — `/plan <feature>` turns a feature into two to six tasks, each with acceptance criteria a
harness run can confirm and an effort class.

**Implement** — `/implement <task>` runs the ladder: `low → low → medium → high` (or from `medium` or
`high` when the task warrants it). An `implementer` agent works under strict constraints, a `harness`
agent verifies against the working tree and reports a structured verdict — a pass is never
self-reported — and an `architect` agent designs only for `high` tasks or after a blocked or failed
attempt. Every run is logged to `.construct/runs.jsonl` with its rungs, attempts and usage.

**Verify · Review · Harden** — `pnpm run quality` is the gate in CI and for every agent; `--review
claude` adds a label-triggered AI review workflow; a finding that recurs becomes a named invariant
with a named check, not a second fix.

## Commands

| Command | What it does |
|---|---|
| `construct init` | Detect, configure, materialize. `--yes --preset node-backend\|node-frontend\|node-library\|monorepo --ai claude\|cursor\|both --review claude --dir . --dry-run` |
| `construct doctor` | Baseline files present, harness intact, discovery markers filled — `GLITCH` by name when not |
| `construct soulkill` | Print what the detector sees, write nothing (`--json`; aliases `inspect`, `capture`) |
| `construct cost` | Token usage of the `/implement` runs in this directory, per agent, billable and price-weighted (`--last`, `--json`) |

`--plain` turns off colours and lore for CI. `--johnny` — wake up, Netrunner.

> If you already keep a user-level `implement` skill in `~/.claude/skills/`, it shadows the one the
> construct puts in `.claude/skills/implement/`; move yours aside to run the repository's ladder.

## What lands in the repository

- `architecture/principles.md`, `checklists.md` — architecture, security and reasoning-budget rules,
  stack-agnostic
- `architecture/security-invariants.md` — `Invariant | Enforced by`, extended by discovery
- `architecture/composition/*.yaml` — composition models; diagrams are rendered from them and checked
- `contracts/api/openapi.yaml` — the HTTP contract; types are generated from it, breaking changes are
  flagged in CI (backend and monorepo presets)
- `scripts/composition`, `scripts/contracts` — the harness pieces behind `pnpm run quality`
- `scripts/construct/implement.workflow.mjs` — the ladder
- `.github/workflows` — CI (the harness), secret scanning, dependency audit, contract diff, AI review
- `.claude/` — `architect`, `implementer` and `harness` agents, `/implement`, `/plan`,
  `/construct-discover`, rules; `.cursor/rules/` for Cursor
- `AGENTS.md` — the repository-specific context with the ten discovery markers; `CLAUDE.md` imports it
- `construct.json` — the manifest: preset, harness command, contract paths, file hashes, marker
  locations

## Mikoshi, constructs and other words

The names are a tribute to Cyberpunk 2077 and mean exactly one thing each here.

| Word | Here |
|---|---|
| Mikoshi | Where constructs are kept: `templates/`, one day a registry of presets |
| Construct | What `init` materializes into a repository — policy, contract, harness, agent instructions |
| Soulkiller | `construct soulkill`: extracts the facts about a repository and writes nothing |
| Netrunner | The coding agent — Claude Code, Cursor — that connects to the project through the construct |
| Relic | The files at the root the agent reads first: `AGENTS.md`, `CLAUDE.md`, `construct.json` |
| Harness | No lore. `pnpm run quality`. The one word that must be understood without this table |

Not affiliated with CD Projekt Red.

## Inspired by

The workflow this tool bootstraps was not invented here; it was assembled from people whose work
shaped it, and then proven on a real product before it became a CLI.

The CSS rules — container queries over media queries, state as attributes, custom properties over
modifier classes, intrinsic layouts — owe everything to [Kevin Powell](https://www.kevinpowell.co/)'s
teaching of modern CSS. The backend discipline — composition roots, one owner per concept, contracts
before implementation, no comments because the code should explain itself — comes from
[Timur Shemsedinov](https://github.com/tshemsedinov)'s Node.js course and the Metarhia community
(Kharkiv). The lifecycle itself — classify, implement, verify, escalate — is the AI-Driven Life Cycle (AI-DLC) idea from
[AWS Labs](https://github.com/awslabs/aidlc-workflows), narrowed to a reasoning budget that verification controls.
None of them has reviewed or endorsed this project; the mistakes are ours.

Built on [@antfu/eslint-config](https://github.com/antfu/eslint-config),
[Redocly](https://redocly.com/), [oasdiff](https://github.com/oasdiff/oasdiff),
[gitleaks](https://github.com/gitleaks/gitleaks),
[openapi-typescript](https://openapi-ts.dev/),
[Claude Code](https://claude.com/claude-code) and its
[Workflow](https://code.claude.com/docs) tool, and the
[claude-code-action](https://github.com/anthropics/claude-code-action) review plugin.

## Support the project

If mikoshi-construct saves you time, consider supporting its development — the Sponsor button on
this repository lists the ways.

I'm also open to sponsorships, partnerships, and opportunities to work on developer tools and
AI-native engineering workflows.

## Development

```bash
pnpm install
pnpm dev init --yes --preset node-backend --dir /tmp/demo
pnpm run quality
```

This repository runs on its own construct — `construct doctor` and `/implement` work here. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
