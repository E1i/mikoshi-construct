---
description: Discover this repository and fill the construct's discovery markers — the step that turns a materialized baseline into a project-specific workflow.
argument-hint: [area to (re)discover, or empty for everything]
---

You are running construct discovery. The CLI detected facts (`construct.json`); your job is to
interpret the system and record what an agent must know to work here safely. Write nothing you did
not verify by reading code; where the codebase is inconsistent, record an open question instead of
inventing a rule.

Scope: `$ARGUMENTS` (empty means every marker). The markers, and the file each one lives in, are
listed under `discovery.markers` in `construct.json` (the text markers in `AGENTS.md` and
`architecture/`, the composition models in the directory `discovery.markers.composition.file` names). Every marker is a block between
`<!-- construct:discover:<name> -->` and `<!-- /construct:discover:<name> -->`; replace the placeholder
line inside the block and nothing outside it. `construct doctor` reports any marker still holding the
placeholder.

Two rules for a repository that already documents itself:

- **One source of truth.** If a block's content already exists elsewhere — a module map in
  `README.md`, review standards in `best_practices.md`, invariants a PR reviewer reads — the marker
  body is a pointer to that place (path and heading), not a copy. Do not duplicate, and do not merge
  the existing document into the construct's files unless the user asks.
- **Move nothing.** Existing composition models, docs and scripts stay where they are; `construct.json`
  already records where the models live. If a construct file links to a path that differs from the
  real one, say so in the report instead of renaming directories.

Work in this order:

1. **Wire the harness.** In a repository that existed before the construct, `init` kept the
   existing `eslint.config.mjs`, `tsconfig.json`, `vitest.config.ts` and `quality` script. Before
   anything else make them cover what the construct added: TypeScript includes `scripts/**/*.ts`,
   Vitest includes `scripts/tests/**/*.test.ts`, and the harness command runs `composition:check`
   (and `contracts:check` when a contract exists). Then run the harness; it must be green before
   discovery starts. Skip this step when the construct created those files itself.
2. **Inventory.** Read `construct.json`, `package.json`, the directory tree two levels deep, the entry
   points (servers, app factories, `main.ts`, CLI scripts, workers), the API contract if there is
   one, and every `*.config.ts` / `config.ts`. Note the package manager, runtime, database and clients, CI, deployment
   and existing conventions. Read every README, at the root and in each app, from start to end before
   writing down how to install, run or test anything: a grep finds only what you already expected, and
   a README states what you did not. Do not write yet. Record the commit this run starts from: set
   `discovery.baseSha` in `construct.json` to the output of `git rev-parse HEAD`, or `null` where the
   repository has no commit yet. Do not record the cleanliness of the tree here: a hypothesis records
   whether its own evidence was committed, one file set at a time, and step 12 says how.

   **The toolchain, when the repository holds Python.** Dependencies are resolved for one interpreter and the machine may hold another, so before any install name the interpreter and what building the lock needs. Search every directory that holds a Python project, below the root as well as at it: a `backend/pyproject.toml` counts as much as one at the root.

   Exact sources name one interpreter:

   - `.python-version`
   - `.tool-versions`
   - `runtime.txt`
   - `python-version` of `actions/setup-python` in a CI workflow
   - `FROM python:<X>` in a `Dockerfile`
   - `python=` in a conda `environment.yml`

   Range sources name a bound, not an interpreter:

   - `requires-python` under `[project]` in `pyproject.toml`
   - `python` under `[tool.poetry.dependencies]` in `pyproject.toml`
   - `python_requires` in `setup.cfg`
   - `python_requires=` in `setup.py`
   - `python_version` under `[requires]` in `Pipfile`
   - `envlist` in `tox.ini`
   - `requires-python` in `uv.lock`
   - `python-versions` under `[metadata]` in `poetry.lock`

   An exact source wins. From a range, name its lower bound and say why: a lock written years ago was resolved against that bound, and the newest interpreter on the machine may have no wheels for what the lock pins. Example: `python = "^3.10"` with a 2023 lock means 3.10, and Poetry picked 3.13 and failed on pillow 9.4.0.

   Say at once, before any install: the version and the file and line it came from; what is on `PATH` (`python3 --version`, and whether `python3.X` resolves); and the command that makes the project's own manager use that interpreter (`poetry env use python3.X`, `uv python install 3.X` or `pyenv install 3.X`). Name the interpreter as `python3.X`; where it is missing that is the Homebrew formula `python@3.X` on macOS, and a distribution package or pyenv on Linux. Install nothing: name the command and leave it to the owner.

   Native dependencies come from the lock, not from a list of package names. A package whose lock entry carries no wheel matching the named interpreter and this platform, only a source distribution, builds from source: read `files` in `poetry.lock`, and `sdist` and `wheels` in `uv.lock`. What that build needs is taken from the package's own installation documentation, cited by link, never from memory. Also compare architectures: `uname -m` against `file "$(command -v pg_config)"`, or against the build tool that documentation names. A build tool of the other architecture on `PATH`, such as an x86_64 `pg_config` from `/usr/local` feeding an arm64 build, fails the install on the machine, not on the project.

   A `requirements.txt` with no lock behind it: say "not determinable from a lock". The check is `pip download --only-binary=:all: --python-version <X.Y> -r requirements.txt -d <tmp dir>`. It needs the network, so it is a check the owner may run, not one you run without a yes. Verified on 2026-10-03 with pip 26.2.1 on macOS arm64: it fails with `No matching distribution found for <pkg>` on a package with no wheel, and builds nothing (no "Building wheel" line, nothing saved). Without `--python-version` it judges by the interpreter pip itself runs on and gives a false result: pillow 9.4.0 fails on 3.14, and with `--python-version 3.10` it saves a cp310 wheel. It stops at the first package without a wheel: with psycopg2 and then lxml 4.9.2 in the file, only psycopg2 is named, so it proves that at least one package builds from source, not the full set.
3. **`product`** (AGENTS.md): what the system does, in one paragraph, and the one flow where a
   defect costs the most (money, identity, data). If the repository is empty apart from the baseline,
   say so in one line.
4. **`module-map`** (AGENTS.md): a table `Path | Purpose` of the top-level modules that exist. Only
   what exists.
5. **`commands`** (AGENTS.md): dev, build, test and operational scripts from `package.json` that the
   baseline block above does not already list, one line each. Remove the placeholder if there are none.
6. **`composition-roots`** (AGENTS.md): the files where services are constructed and routes, jobs or
   handlers are mounted, and the rule for adding a new one.
7. **`dependency-policy`** (AGENTS.md, and `eslint.config.mjs`): which modules or packages may import
   which. Describe it in one paragraph and make sure `eslint.config.mjs` enforces it — extend the
   policy blocks there (`ALLOWED_WORKSPACE_IMPORTS`, the `restrictSyntax` rules); a declared policy
   that lint does not enforce is not a policy.
8. **`high-effort-areas`** (AGENTS.md): the paths where a wrong low-effort guess is expensive —
   attribution, authentication, money, schema, anything a shipped client depends on. This list is what
   `/implement` uses to classify a task as `high`. In a repository with no `construct.json` and a
   `.construct/attach.json` (an attached repository) there is no marker to fill and the construct
   owns neither `AGENTS.md` nor `CLAUDE.md`: write the same list to
   `.construct/high-effort-areas.md`, one `- <path or directory/> — <why>` line per area, and write
   nothing outside `.construct/`. The attach exclude block already covers `.construct/`, so the file
   stays out of `git status`; `/implement` reads it from there.
9. **`composition`** (`<discovery.markers.composition.file>/*.yaml` from `construct.json`): one model per real flow the code has today
   (the HTTP app, a worker, a sync, a CLI, the browser bootstrap) — small, one per flow, every `path`
   must exist. A baseline model, when the construct shipped one, is updated, not duplicated; a
   repository that had code before the construct starts with no model and needs at least one for its
   main entry point. Add a `doc:` markdown with the `<!-- composition:<id> -->` block, run
   `pnpm composition:render`, and confirm `pnpm composition:check` passes.
10. **`security-invariants`** (`architecture/security-invariants.md`): rows in the form
   `Invariant | Enforced by` for the system-specific invariants — ownership checks, role middleware,
   integer money, closed DTOs. Name the mechanism that enforces each and what it matches (the lint
   block and its selectors, the test file, the scanner or workflow job), never a bare tool name; write
   `review` only when nothing mechanical exists yet, and prefer adding the check to writing the word.
11. **`defects-vs-variance`** (AGENTS.md): what a reviewer must flag here beyond the baseline list.
    **`open-questions`** (`architecture/open-questions.md`): what looks like a convention but is not
    consistently applied. When `discovery.markers.open-questions.file` still names `AGENTS.md` and
    `architecture/open-questions.md` carries the marker, this run moves it: write the body into that
    file's block, delete the whole `open-questions` block (both tags) from `AGENTS.md`, and record the
    new `file` in step 12. Rewrite each relative link in the body for the `architecture/` folder and
    change nothing else. A moved body is not a body this run wrote, so it carries the provenance
    `construct doctor` read before the move: when it read `construct`, record the sha of the moved
    body; otherwise change only `file` and keep `authoredBy` and `sha`, so an owner's edit still
    reads as theirs. A repository without that file keeps the marker where it is.
12. **Write what you concluded, into the model.** A marker is prose answering *what is where*; a
    hypothesis in `construct.model.json` is a structural record answering *what this is*, falsifiable
    by facts. This step stands on what the inventory and the markers established and writes
    independently of them: never re-read the prose above and turn it into entries. Where the
    repository has no `construct.model.json`, say so in the report and create none — that file is
    written by `init`, and its absence is a state of the repository, not something to repair here.

    For each interpretation you are prepared to stand behind, add one entry under `hypotheses` and the
    facts it stands on under `facts`. Everything you write here carries `"authoredBy": "discovery"`,
    which is what keeps the next `init` from replacing it. Each hypothesis carries the `baseSha` step
    2 recorded and its own `evidenceClean`: whether the files named by *that hypothesis's* facts — those
    files only, not the tree around them — carried uncommitted changes when you read them. Compute it,
    never estimate it, over the paths of the facts under it:

    ```bash
    git status --porcelain -- apps/billing/Dockerfile apps/billing/package.json pnpm-workspace.yaml
    ```

    Empty output is `"evidenceClean": true`; any line is `false`. A repository that has just been
    adopted answers both ways — a hypothesis standing on files the repository already committed reads
    `true`, one standing on a file `init` wrote reads `false`.

    A fact is what code can look at without judgement, and there are five kinds and no sixth:
    `file-exists` names a `path`, `file-contains` and `file-lacks` name a `path` and a literal
    `needle`, `report-covers` and `report-misses` name a runner's report as `path`, a `surface` of
    globs, and a `format`: `vitest-json` (the default, read when `format` is absent) or `junit-xml`.
    Point a `junit-xml` fact's `path` at a report produced by
    `pytest -o junit_family=xunit1 --junitxml=<path>` — the xunit1 shape the reader understands.
    An interpretation those kinds cannot support does not enter the model at all — it stays prose in the
    marker where it belongs. *Service-oriented structure*, standing on four directories under `apps/`
    each holding a Dockerfile, is admissible; *the architecture is mature* is not. Where an
    interpretation looks as though it needs a third kind of fact, write that down under
    `open-questions`, naming the fact you wanted and what it would have settled. Do not invent the
    kind.

    Worked example — a repository whose `apps/` holds services, showing only the entries this step
    wrote; the claims `init` wrote stay where they are:

    ```json
    {
      "modelVersion": 1,
      "facts": [
        { "id": "billing-service-dockerfile", "kind": "file-exists", "path": "apps/billing/Dockerfile", "authoredBy": "discovery" },
        { "id": "billing-service-manifest", "kind": "file-exists", "path": "apps/billing/package.json", "authoredBy": "discovery" },
        { "id": "workspace-covers-apps", "kind": "file-contains", "path": "pnpm-workspace.yaml", "authoredBy": "discovery", "needle": "apps/*" }
      ],
      "claims": [],
      "hypotheses": [
        {
          "id": "service-oriented-structure",
          "statement": "Each directory under apps/ is a deployable service with its own manifest and image, rather than a module of one application",
          "authoredBy": "discovery",
          "baseSha": "9f1c0b7e1b3b9f0e2a4c6d8e0a2b4c6d8e0a2b4c",
          "evidenceClean": true,
          "supportedBy": ["billing-service-dockerfile", "billing-service-manifest", "workspace-covers-apps"]
        }
      ]
    }
    ```

    Then name the components of each contour. Run `construct atlas`; the Engram it names holds
    `mechanics.contours`, the parts the repository's own configuration separates, and
    `mechanics.components`, every tracked file. Inside each contour, group its files into components —
    each a part a reader would name, with an `id`, the `contour` it lies in, a `name` and a one-line
    `purpose` — and write them under the top-level `interpretation` key of that same Engram, beside
    `mechanics` and never inside it. A file belongs to at most one component; a file you cannot place
    stays out, and the Atlas groups it by its directory. Name a component by what it does, not by the
    directory it sits in, and write no fact, no claim and nothing under `mechanics`: discovery rewrites
    `mechanics` on every run, and the facts must read the same with or without your layer. Then run `construct atlas` again and open
    the page it names.

    ```json
    {
      "facts": [],
      "claims": [],
      "interpretation": {
        "authoredBy": "discovery",
        "components": [
          { "id": "billing-api", "contour": "apps/billing", "name": "Billing API", "purpose": "Takes a charge request, validates it against the contract and records the charge", "files": ["apps/billing/src/routes.ts", "apps/billing/src/charge.ts"] }
        ]
      }
    }
    ```

    Where the repository renders its model — a committed diagram or page generated from
    `construct.model.json`, the way the composition models are rendered in step 9 — regenerate it in
    the same step that changed the model, and confirm its check passes. Writing the source and leaving
    the artifact behind is what turns the next harness run red for a reason nobody will connect to this
    step.

13. **Prove it.** Run the harness command from `construct.json`. Fix anything discovery broke (a
    stale rendered diagram, a lint rule with no matching file). Then run `construct doctor`, or
    `npx mikoshi-construct doctor` when the CLI is not installed; it names every marker that still
    holds the placeholder.

14. **Record what you wrote, each in its own file and nowhere else.** Provenance belongs in
    `construct.json` and nowhere else; interpretation belongs in `construct.model.json` and nowhere
    else. Never add a byline, an authorship note or a hash to a marker body, and never restate a
    hypothesis or the facts under it as prose somewhere a reader would then have two versions of. Set
    `discovery.filledAt` to the time you finished, and for each marker you filled set
    `discovery.markers.<name>` to `{"file": "<the file it lives in>", "authoredBy": "construct",
    "sha": "<sha256 of the body you wrote>"}`. A marker you did not fill keeps the entry it had.
    The body is the text between `<!-- construct:discover:<name> -->` and
    `<!-- /construct:discover:<name> -->` with leading and trailing whitespace stripped; for
    `composition` it is every `*.yaml` in the directory, sorted by name, each as its filename, a
    newline and its contents, joined by newlines. Compute it, never estimate it:

    ```bash
    node -e 'const{createHash}=require("node:crypto"),{readFileSync}=require("node:fs");const[f,m]=process.argv.slice(1);const d=readFileSync(f,"utf8"),o=`<!-- construct:discover:${m} -->`,c=`<!-- /construct:discover:${m} -->`;console.log(createHash("sha256").update(d.slice(d.indexOf(o)+o.length,d.indexOf(c)).trim()).digest("hex"))' AGENTS.md product
    node -e 'const{createHash}=require("node:crypto"),{readFileSync,readdirSync}=require("node:fs"),p=require("node:path");const d=process.argv[1],b=readdirSync(d).filter(n=>n.endsWith(".yaml")).sort().map(n=>`${n}\n${readFileSync(p.join(d,n),"utf8")}`).join("\n");console.log(createHash("sha256").update(b).digest("hex"))' architecture/composition
    ```

    This is what keeps a statement the tool wrote from later reading as one the repository stands
    behind. The moment the owner edits a marker its body stops matching the recorded sha and
    `construct doctor` reads it as theirs — the edit is the evidence, and there is no command to run.

Report: which markers you filled, which you left as open questions and why, the hypotheses you wrote
into the model or the absence of a model to write them into, and the harness result.
Do not commit.
