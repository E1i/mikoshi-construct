---
description: Discover this repository and fill the construct's discovery markers — the step that turns a materialized baseline into a project-specific workflow.
argument-hint: [area to (re)discover, or empty for everything]
---

You are running construct discovery. The CLI detected facts (`construct.json`); your job is to
interpret the system and record what an agent must know to work here safely. Write nothing you did
not verify by reading code; where the codebase is inconsistent, record an open question instead of
inventing a rule.

Scope: `$ARGUMENTS` (empty means every marker). The markers, and the file each one lives in, are
listed under `discovery.markers` in `construct.json` (the text markers in `AGENTS.md`, the composition
models in the directory `discovery.markers.composition.file` names). Every marker is a block between
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
   anything else make them cover what the construct added: ESLint ignores
   `scripts/construct/*.workflow.mjs` (top-level `return`), TypeScript includes `scripts/**/*.ts`,
   Vitest includes `scripts/tests/**/*.test.ts`, and the harness command runs `composition:check`
   (and `contracts:check` when a contract exists). Then run the harness; it must be green before
   discovery starts. Skip this step when the construct created those files itself.
2. **Inventory.** Read `construct.json`, `package.json`, the directory tree two levels deep, the entry
   points (servers, app factories, `main.ts`, CLI scripts, workers), the API contract if there is
   one, and every `*.config.ts` / `config.ts`. Note the package manager, runtime, database and clients, CI, deployment
   and existing conventions. Do not write yet. Record the commit this run starts from: set
   `discovery.baseSha` in `construct.json` to the output of `git rev-parse HEAD`, or `null` where the
   repository has no commit yet. Note now whether `git status --porcelain` is empty at this moment:
   that is the tree every reading below is made from, and your own writes are about to dirty it.
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
   `/implement` uses to classify a task as `high`.
9. **`composition`** (`<discovery.markers.composition.file>/*.yaml` from `construct.json`): one model per real flow the code has today
   (the HTTP app, a worker, a sync, a CLI, the browser bootstrap) — small, one per flow, every `path`
   must exist. A baseline model, when the construct shipped one, is updated, not duplicated; a
   repository that had code before the construct starts with no model and needs at least one for its
   main entry point. Add a `doc:` markdown with the `<!-- composition:<id> -->` block, run
   `pnpm composition:render`, and confirm `pnpm composition:check` passes.
10. **`security-invariants`** (`architecture/security-invariants.md`): rows in the form
   `Invariant | Enforced by` for the system-specific invariants — ownership checks, role middleware,
   integer money, closed DTOs. Name the lint rule, test or scanner that enforces each; write `review`
   only when nothing mechanical exists yet, and prefer adding the check to writing the word.
11. **`defects-vs-variance`** and **`open-questions`** (AGENTS.md): what a reviewer must flag here
    beyond the baseline list, and what looks like a convention but is not consistently applied.
12. **Write what you concluded, into the model.** A marker is prose answering *what is where*; a
    hypothesis in `construct.model.json` is a structural record answering *what this is*, falsifiable
    by facts. This step stands on what the inventory and the markers established and writes
    independently of them: never re-read the prose above and turn it into entries. Where the
    repository has no `construct.model.json`, say so in the report and create none — that file is
    written by `init`, and its absence is a state of the repository, not something to repair here.

    For each interpretation you are prepared to stand behind, add one entry under `hypotheses` and the
    facts it stands on under `facts`. Everything you write here carries `"authoredBy": "discovery"`,
    which is what keeps the next `init` from replacing it. Each hypothesis carries the `baseSha` step
    2 recorded and the `baseClean` of that same starting tree — the reading is about the tree you read,
    not about the tree you leave behind.

    A fact is what code can look at without judgement, and there are two kinds and no third:
    `file-exists` names a `path`, `file-contains` names a `path` and a literal `needle`. An
    interpretation those two cannot support does not enter the model at all — it stays prose in the
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
          "baseClean": true,
          "supportedBy": ["billing-service-dockerfile", "billing-service-manifest", "workspace-covers-apps"]
        }
      ]
    }
    ```

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
