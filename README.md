# mikoshi-construct

Bootstrap for AI-native software projects. Start with a proven engineering workflow instead of an
empty repository.

**[Documentation](https://e1i.github.io/mikoshi-construct/)** · [Getting started](https://e1i.github.io/mikoshi-construct/guide/getting-started) · [The development cycle](https://e1i.github.io/mikoshi-construct/guide/the-cycle) · [CLI reference](https://e1i.github.io/mikoshi-construct/cli)

```bash
mkdir my-service && cd my-service
npx mikoshi-construct init          # interactive: preset, agent, project name
pnpm install && pnpm run quality    # green before you write a line
```

> Presets `node-backend`, `node-frontend`, `node-library` and `monorepo`. Claude Code gets the full
> lifecycle; Cursor gets the rules, the conventions and the discovery protocol. What a repository has
> become lives in two records: `construct.json`, the provenance of what was materialized and by which
> version, and `construct.model.json`, the knowledge — facts, claims and hypotheses, each standing on
> evidence a reader can re-check. `sync` replays the first against today's templates, `graph` draws
> the second, and `doctor` reads both.


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

## Usage

**A new project.** Name a preset and it writes everything:

```bash
mkdir my-service && cd my-service
npx mikoshi-construct init --yes --preset node-backend
pnpm install && pnpm run quality
```

**An existing repository.** Look before you write:

```bash
npx mikoshi-construct init --preset monorepo --dry-run
```

```
  ~ package.json (merge)
  = eslint.config.mjs — exists, review manually
  + architecture/principles.md
  + .claude/commands/construct-discover.md

  Sample sources omitted: the directory is not empty. Discovery maps what is already here.
```

`+` creates a file that is not there. `~` merges into one that is, inside a
`construct:begin … construct:end` block or as a JSON merge where your values win. `=` leaves the file
alone and reports it. No example code lands in a repository that already has some, and there is no
`--force`.

**Cursor, or both agents.** The rules are written once and rendered for each:

```bash
npx mikoshi-construct init --yes --preset node-frontend --ai both
```

**Check a repository at any time.**

```bash
npx mikoshi-construct doctor     # baseline intact, harness intact, markers filled
npx mikoshi-construct sync       # what newer templates would change; writes nothing
npx mikoshi-construct soulkill   # what the detector sees; writes nothing
npx mikoshi-construct cost --last
```

`sync` reports and changes nothing until you ask for `--apply`, and even then it writes only what
the construct itself wrote and you have not touched.

Every command, flag and exit code: [docs/cli.md](https://github.com/E1i/mikoshi-construct/blob/main/docs/cli.md).

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

The second principle in numbers, from thirteen `/implement` runs on this repository (Claude Opus).
Two `low` tasks cost 557k and 740k billable tokens. Nine `medium` tasks cost between 847k and 5.9M —
the class is a weak predictor on its own. Two `high` tasks, each with an architect designing before
any code, cost 14.19M and 14.14M.

Almost none of that is the work. It is each agent's entry into the repository: a fresh exploration,
paid in full before anything is produced, and paid again by every agent that starts. A `low` run pays
it twice — an implementer, and the harness that refuses to let the implementer mark its own homework.
A `high` run pays it three times. The class mostly decides how deep each entry goes; the ladder
decides how many entries there are, and that is what it is for.

The same arithmetic prices a bad brief. One run escalated to an architect after the implementer
stopped on a contradiction in the task, and the architect spent 3.66M without returning a valid
answer — 4.16M for the run, for nothing. That is why a response the schema rejects is not re-asked by
default: a second attempt buys another entry, not another answer. `construct cost` prints all of this
for your own runs, and reconciles it against the ledger the ladder writes.

## The lifecycle

**Discover** — `/construct-discover` reads the repository and fills `AGENTS.md` and `architecture/`:
what the product does and where a defect costs the most, the module map, the composition roots, the
dependency policy (and makes lint enforce it), the high-effort areas, one composition model per real
flow, the security invariants with their checks, what a reviewer must flag, and what looks like a
convention but is not. Where a section already exists in the repository, the marker points at it.

**Plan** — `/plan <feature>` turns a feature into two to six tasks, each with acceptance criteria a
harness run can confirm — shown failing before the implementation exists, or they are intent rather
than criteria — and an effort class.

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
| `construct attach` | Bring `/plan`, `/implement`, the three agents and the ladder into a repository the construct did not write, hidden through `.git/info/exclude`; never touches a tracked file (`--harness <command>`, `--yes`; alias `jack-in`) |
| `construct detach` | Remove exactly what `attach` recorded — its files by hash, their emptied directories, the exclude block and the record — and nothing else; refuses when a carrier was changed (alias `jack-out`) |
| `construct doctor` | Baseline files present, harness intact, discovery markers filled — `GLITCH` by name when not |
| `construct sync` | Classify every path against today's templates and report; `--apply` writes only what the construct owns and you have not changed (`--json`) |
| `construct soulkill` | Print what the detector sees, write nothing (`--json`; aliases `inspect`, `capture`) |
| `construct graph` | Draw the model — claims, hypotheses and the evidence under them — as a Mermaid flowchart on stdout |
| `construct cost` | Token usage of the `/implement` runs in this directory, per agent, billable and price-weighted (`--last`, `--json`) |

`--plain` turns off colours and lore for CI. `--johnny` — wake up, Netrunner. The full reference,
with examples and exit codes, is in [docs/cli.md](https://github.com/E1i/mikoshi-construct/blob/main/docs/cli.md).

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
| Engram | The record `init` cut into `construct.json`: what the construct wrote, and the version that wrote it |
| Braindance | `construct sync`: replaying that engram against today's templates and reporting where the two disagree |
| Jack in | `construct attach`: the agent carriers alone, into a repository the construct did not write, hidden from git and recorded in `.construct/attach.json` |
| Jack out | `construct detach`: the inverse of jack in — removes what the record lists, leaves a carrier git has adopted or a file attach did not write, and reports each by name |
| Breach Protocol | The attach procedure: the seven refusals it runs, in order, before touching anything — `BREACH FAILED` names the one that fired |
| Relic write | `construct sync --apply`: the one write into a repository the construct did not create |
| Blackwall | Where a construct block whose template variant cannot be established sits — not yours, not ours, and nothing is written there |
| Glitch | A warning in the output. Something wants a human; nothing has failed |
| Flatlined | A check that failed outright: a missing baseline file, or no `construct.json` where one was required |
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

## Get in touch

I'm open to sponsorships, partnerships, and opportunities to work on developer tools and AI-native engineering workflows