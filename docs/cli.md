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
and each discovery marker is either filled or named as missing.

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
```

Unfilled markers are reported but do not fail the command, because discovery is the agent's job and
the harness has to stay usable before it runs. Exits `1` only when a baseline file has gone missing
or the harness is broken. Files you have edited since `init` are expected and counted, not faulted.

```json
{
  "ok": true,
  "missingFiles": [],
  "modifiedFiles": [],
  "missingDiscovery": ["product", "module-map"],
  "harnessProblems": []
}
```

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

  ├─ Directory: /home/eli/projects/my-service
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
| `--json` | `false` | The runs as JSON. |

```bash
npx mikoshi-construct cost --last
```

Each agent line carries its call count and its input, cache-write, cache-read and output tokens. The
run total is printed twice: billable tokens, and an input-equivalent figure that weights cache writes
at 1.25, cache reads at 0.1 and output at 5, so a cheap run and an expensive one can be compared at a
glance. Exits `1` when Claude Code has no session data for the directory.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The command did what it said. |
| `1` | `init` was declined or failed; `doctor` found a missing baseline file or a broken harness; `cost` found no session data. |

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
