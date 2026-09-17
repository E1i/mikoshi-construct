# CLI reference

Every command, every flag, and what each one exits with. The short version lives in
[README.md](https://github.com/E1i/mikoshi-construct#usage).

```bash
npx mikoshi-construct <command> [options]   # no install
construct <command> [options]               # after a global install
miko <command> [options]                    # same binary, fewer keystrokes
```

`construct`, `miko` and `mikoshi-construct` are the same executable.

## Options every command takes

| Option | Default | What it does |
|---|---|---|
| `--dir <path>` | `.` | The repository to act on. Created if it does not exist. |
| `--plain` | `false` | No colour, no lore, no emoji. Use it in CI and in scripts. |
| `--johnny` | `false` | A second palette and a different greeting. Cosmetic. |

Colour also turns itself off when `NO_COLOR` is set or when stdout is not a terminal.
Flags accept either spelling, so `--dry-run` and `--dryRun` both work.

## construct init

Detects the repository, asks what it cannot detect, then writes the construct: architecture policy,
the harness, an API contract where the preset has one, and the agent instructions. It ends by
printing what to run next.

| Option | Default | What it does |
|---|---|---|
| `--preset <id>` | asked | `node-backend`, `node-frontend`, `node-library` or `monorepo`. |
| `--ai <target>` | `claude` | `claude`, `cursor` or `both`. Decides whether you get `.claude/`, `.cursor/rules/` or both. |
| `--name <name>` | directory name | The project name written into `package.json` and the agent files. |
| `--review <provider>` | `none` | `claude` adds the label-triggered review workflow. It needs a `CODE_REVIEW_API_KEY` secret. |
| `--review-model <model>` | `claude-sonnet-5` | The model that review workflow runs. |
| `--yes`, `-y` | `false` | Ask nothing. Take the defaults and skip the confirmation. |
| `--dry-run` | `false` | Print the plan and write nothing. |

Without `--yes` and with a terminal attached, `init` asks only for what the flags left open. Piping
input without `--yes` is refused rather than guessed at.

Exits `0` when it writes or when `--dry-run` finishes, `1` when you decline the confirmation or when
the target cannot be read.

### A new project

```bash
mkdir my-service && cd my-service
npx mikoshi-construct init --yes --preset node-backend
pnpm install
pnpm run quality
```

The harness is green before you write a line. That is the point of the preset: the contract, the
composition model and its rendered diagram, the lint policy and the tests all ship consistent with
each other.

### An existing repository

Look before you write. `--dry-run` prints the plan and touches nothing:

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

Three markers tell you what will happen. `+` creates a file that is not there. `~` merges into one
that is, and only inside a `construct:begin … construct:end` block or as a JSON merge where your
values win. `=` leaves the file alone and reports it. An existing repository never receives example
code, and there is no `--force`.

### Choosing the agent

```bash
npx mikoshi-construct init --yes --preset node-frontend --ai both
```

The rules are written once and rendered for each target. Claude Code reads `.claude/rules/*.md` with
`paths:` frontmatter; Cursor reads the same rules as `.cursor/rules/*.mdc` with `globs`. The
discovery protocol ships as `/construct-discover` for Claude Code and as an agent-requested rule for
Cursor.

### Pull request review

```bash
npx mikoshi-construct init --yes --preset node-backend --review claude --review-model claude-opus-5
```

Adds `.github/workflows/claude-review.yml`, which runs when you put the `claude-review` label on a
pull request. Add a `CODE_REVIEW_API_KEY` secret to the repository or the workflow will not start.

## construct doctor

Checks that the construct is intact: every file the manifest recorded is still present, the harness
command still runs lint, typecheck and tests, the contract paths in `construct.json` still resolve,
and each discovery marker is either filled or named as missing. It then answers a second question —
at what level each gate the repository claims is actually enforced — and ends with one line naming
the weakest of them.

| Option | Default | What it does |
|---|---|---|
| `--json` | `false` | The full result as JSON, for CI. |

```bash
npx mikoshi-construct doctor
```

```
[warn] WARNING: Discovery incomplete.

    Missing:
      product
      module-map
      composition-roots

    Run: claude → /construct-discover
[ok] OK

Enforcement
  lint-policy      L3  present  scripts/tests/lint/syntax-policy.test.ts resolves the lint policy …
  construct-tests  L3  present  all 7 test files recorded in construct.json match the include …
  ci               L3  present  .github/workflows/ci.yml runs "pnpm run quality"; branch protection …
  hook             L0  absent   no .husky, lefthook, simple-git-hooks or core.hooksPath configuration …
  red-gate         L3  unknown  doctor executes nothing from the repository it inspects …

Weakest link: lint-policy at L3
```

Unfilled markers are reported but do not fail the command, because discovery is the agent's job and
the harness has to stay usable before it runs. Exits `1` only when a baseline file has gone missing
or the harness is broken. Files you have edited since `init` are expected and counted, not faulted.
A low level is information, not a failure: levels, states and the weakest link never change the exit
code.

### What doctor does not do

`doctor` executes nothing from the repository it inspects: no child process, no dynamic import of a
path inside it, no `require` into its `node_modules`, no call into its ESLint or Vitest APIs. It is
run through `npx` in a fresh clone, before anyone has decided whether that code is trustworthy, and
a flat ESLint config is a module — resolving it would run the audited repository's own code on the
instruction "check whether this repository is honest". Every verdict below is derived from reading
file text, over the files `construct.json` records plus a fixed allowlist (`package.json`, the
vitest or vite config, `.github/workflows/*`, the hook manager configs, `.git/config`).

Two consequences follow. `doctor` never reports `L4`: branch protection and organisation rulesets
live in the GitHub API, not in the repository, so the most a file can show is `L3`. And whatever it
cannot read literally is `unknown`, never `absent` — the red gate always, because proving a clean
checkout is green means running it. See
[architecture/decisions/0007-doctor-executes-nothing.md](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0007-doctor-executes-nothing.md).

### The levels

| Level | Meaning |
|---|---|
| `L0` | Text, or a command nobody is obliged to run. |
| `L1` | A human in review. |
| `L2` | Local: a git hook, bypassable with `--no-verify`. |
| `L3` | CI that does not block a merge. |
| `L4` | CI that blocks a merge. Never reported by `doctor`. |

### The checks

Each check returns `{id, level, state, evidence}`, with `state` one of `present`, `absent` or
`unknown` and `evidence` naming the file or key it read — and, when the chain breaks, its weakest
link.

| Check | What it reads | What it can conclude |
|---|---|---|
| `lint-policy` | The recorded files that resolve the policy with ESLint's `calculateConfigForFile`, the runner include globs, the harness script, the workflows | `present` at the level that whole chain supports; `absent` at `L0` when no such test exists or nothing runs it; `unknown` when the include cannot be read literally |
| `construct-tests` | Every `*.test.ts` recorded in `construct.json`, against the include list read literally from the runner config | `present` when the runner collects all of them and the harness runs the runner; `absent` at `L0` for an orphan; `unknown` for a missing, non-literal or unreadable include |
| `ci` | `.github/workflows/*.yml`, the `run:` steps only | `present` at `L3` when a step runs the harness command, otherwise `unknown`. Never `absent`, and never `L4` |
| `hook` | `.husky/*`, `lefthook.*`, `simple-git-hooks` (file or `package.json` key), `core.hooksPath` in `.git/config`, and the `precommit` script | `present` at `L2` for a hook manager, `present` at `L0` for a bare script nothing installs, `absent` at `L0` |
| `red-gate` | Nothing: answering it means running the harness | Always `unknown`, with evidence saying so. CI is where a clean checkout is proven |

Typecheck is not a check. Where a bare `tsc --noEmit` cannot carry a stack, the preset contributes a
line to `warnings` instead — a framework matrix would grow faster than it could be closed.

The last line names the weakest link: the lowest level among the gates the repository claims, which
is to say the checks that came back `present`. Checks that are `absent` or `unknown` are printed on
their own lines but do not set it, and when nothing is claimed the line says so.

```json
{
  "ok": true,
  "missingFiles": [],
  "modifiedFiles": [],
  "missingDiscovery": ["product", "module-map"],
  "harnessProblems": [],
  "warnings": [],
  "checks": [
    {
      "id": "lint-policy",
      "level": "L3",
      "state": "present",
      "evidence": "scripts/tests/lint/syntax-policy.test.ts resolves the lint policy with calculateConfigForFile, vitest.config.ts includes \"tests/**/*.test.ts\", \"scripts/tests/**/*.test.ts\", and \"quality\" runs the test runner; .github/workflows/ci.yml runs \"pnpm run quality\""
    },
    {
      "id": "hook",
      "level": "L0",
      "state": "absent",
      "evidence": "no .husky, lefthook, simple-git-hooks or core.hooksPath configuration and no pre-commit script in package.json"
    }
  ],
  "weakestLink": { "id": "lint-policy", "level": "L3" }
}
```

`ok`, `missingFiles`, `modifiedFiles`, `missingDiscovery` and `harnessProblems` keep their names,
types and meaning; `warnings`, `checks` and `weakestLink` are added after them. `checks` is always in
the order above — `lint-policy`, `construct-tests`, `ci`, `hook`, `red-gate` — and `weakestLink` is
`null` when no check is `present`.

## construct soulkill

Prints what the detector sees and writes nothing. It is the same code `init` runs, so it is also how
you debug a preset suggestion you did not expect. Aliases: `inspect`, `capture`.

| Option | Default | What it does |
|---|---|---|
| `--json` | `false` | The detect report as JSON. |

```bash
npx mikoshi-construct soulkill
```

```
>> Inspecting repository...

  ├─ Directory: /srv/projects/my-service
  ├─ Runtime: Node.js 24
  ├─ Package manager: pnpm (pnpm 12.4.2 installed)
  ├─ Layout: monorepo (pnpm-workspace)
  ├─ Workspace dirs: apps, packages (7 packages)
  ├─ src/: no
  ├─ Contracts: contracts/api/openapi.yaml
  ├─ tsconfig / ESLint config: yes / yes
  ├─ GitHub workflows: yes
  ├─ CLAUDE.md / AGENTS.md / .cursor/rules: yes / yes / yes
  └─ construct.json: no
```

These are facts, not opinions. The detector reports the package manager, the layout, the workspace
packages and which files already exist. Anything that needs judgement is left to discovery.

## construct cost

Reads the Claude Code session files for this directory and sums the tokens each `/implement` run
spent, per agent. It is the evidence behind the reasoning budget: cheap tasks should stay cheap.

| Option | Default | What it does |
|---|---|---|
| `--last` | `false` | Only the most recent run. |
| `--json` | `false` | The report as a JSON object. |

```bash
npx mikoshi-construct cost --last
```

Each agent line carries its call count and its input, cache-write, cache-read and output tokens. The
run total is printed twice: billable tokens, and an input-equivalent figure that weights cache writes
at 1.25, cache reads at 0.1 and output at 5, so a cheap run and an expensive one can be compared at a
glance.

The runtime is resolved first — from the environment the command runs in, otherwise from the `ai`
target in `construct.json` — and only then asked for its usage. A runtime whose per-run usage is not
readable (Cursor, for instance, which keeps no such session files) is reported as `unsupported`,
never as an absence of runs.

`--json` prints one object: `status` (`ok`, `empty`, `unsupported`, `mismatch` or `unknown`),
`runtime` (`claude-code` or `cursor`), `key` and `candidates` where the project key is in question,
`runs` when there are any, and `ledger` and `reconciliation` as described below.

### The run ledger

`.construct/runs.jsonl` is the ladder's own journal: one JSON line per `/implement` run, appended by
step 4 of the `implement` skill. That step is an instruction in a prompt — nothing makes it happen
and nothing notices when it does not — so the ledger is **L0** on the scale `doctor` reports: a
record nobody is obliged to keep. Read it as a claim to be checked, never as a complete history of
what ran. Decision 0003 records why it stops there.

Each line carries exactly these fields:

| Field | Meaning |
|---|---|
| `run` | The Workflow run identifier the runtime reported for the run. This is the join key. |
| `at` | ISO timestamp of the run. |
| `task` | The task text, first 120 characters. |
| `effort` | The effort class the caller chose before the run. |
| `status` | `done`, `failed` or `blocked`. |
| `rung` | The effort of the rung that finished. |
| `attempts` | One object per attempt: `rung`, `effort`, `outcome`, and a `reason` separating an invalid response shape from a red harness from a blocked report. |
| `agents`, `tokens`, `toolUses`, `seconds` | The Workflow tool's accounting for the whole run. `tokens` may be the string `unknown`; it is never rewritten as `0`. |

The Workflow tool reports accounting per run, not per agent, so the ledger declares no per-agent
field. It carries counts and reasons only — never a prompt or a response, which keeps the invariant
that cost reads token counts and never message content.

A line that does not parse, or that is missing a declared field, is reported as malformed with its
line number rather than skipped: a ledger that quietly drops what it cannot read is worse than no
ledger.

### Reconciliation

Where the runtime exposes session data, `cost` joins ledger entries to runtime runs on `run` and
reports the drift in both directions — never by pairing entries to sessions chronologically, which
would be a guess dressed as a finding:

| Finding | Meaning |
|---|---|
| `entriesWithoutSession` | The ledger claims a run the runtime has no session for. |
| `sessionsWithoutEntry` | A run happened and was never logged — the skipped step the ledger cannot see. |
| `unjoinable` | Entries carrying no `run`, including every entry written before the key existed. They are counted, not matched. |

These are information, not failures: they never change the `status` or the exit code. On a runtime
that exposes no per-run usage there is nothing to join against, so the report shows the ledger's own
counts — runs, agents, unfinished runs — with every token figure marked `unknown` rather than `0`,
because `0` is a number and it would be a lie.

| `status` | Exit | Meaning |
|---|---|---|
| `ok` | `0` | Runs were read and printed. |
| `empty` | `0` | The runtime is readable and this directory has no recorded runs. |
| `mismatch` | `1` | No directory for the looked-up project key, but the path this directory resolves to — or the main worktree it belongs to — has one. The report names the key that was looked up. |
| `unknown` | `1` | Sibling keys look like this repository without settling it; the report says so rather than guessing. |
| `unsupported` | `3` | This runtime does not expose per-run token usage. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The command did what it said. |
| `1` | `init` was declined or failed; `doctor` found a missing baseline file or a broken harness; `cost` could not match the directory to the recorded project key (`mismatch` or `unknown`). |
| `3` | `cost` ran under a runtime that does not expose per-run token usage (`unsupported`). |

## After init

`init` writes the files and stops. The rest of the lifecycle belongs to the agent and to the harness:

```bash
pnpm install && pnpm run quality   # the gate, green from the first run
claude                             # then /construct-discover
```

`/construct-discover` fills the ten markers in `AGENTS.md` and `architecture/` by reading the code.
`/plan` turns a feature into tasks with acceptance criteria. `/implement` runs the reasoning-budget
ladder and lets the harness decide when more effort is warranted. Cursor users ask the agent to run
construct discovery instead, and it follows the same protocol.
