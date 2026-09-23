# 0030 — The public contract is a recorded surface, and changing it requires the bump it implies

Status: proposed · 2026-09-23

## Context

The road to 1.0 needs a statement of what an outside reader may rely on. A measurement of `main`
listed every candidate, where it is defined and what would catch an incompatible change to it today.
Two findings shape this record.

**Most of the command-line surface is held by nothing.** Flag names are never parsed by a test,
because the tests call the `run*` functions with option objects. The exit codes of `init`, `attach`,
`detach` and `doctor --json` are assigned inline in `src/cli.ts`, and the tests assert a status rather
than the code. The exit-code table in `docs/cli.md` is read by no test. The key set of
`soulkill --json` is untested, although the scripts that consume it are the reason it exists.

**Most of what is held is held by a mirror.** A test that compares against the same constant it
guards (`SYNC_EXIT.pending`, `ATTACH_CARRIERS`, `DISCOVERY_MARKERS`), or against a document edited in
the same change (`doctor --json` against `docs/cli.md`), catches a change made on one side only. A
deliberate incompatible change made on both sides passes in silence. Only `construct.json` and
`construct.model.json` carry a version together with frozen fixtures, and `.construct/attach.json`
carries a `recordVersion` that no reader checks.

## Decision

### 1. What the contract contains

**Inside:** the commands and their aliases, flag names, exit codes per command and state, the key
sets of `doctor --json`, `sync --json` (with and without `--apply`), `cost --json` and
`soulkill --json`, the format versions of `construct.json`, `construct.model.json` and
`.construct/attach.json`, the paths `init` and `attach` write, and the block markers
(`construct:begin … end` in both comment styles, and `construct:discover:<marker>`).

**Outside:** `.construct/runs.jsonl`, the HTML written by `graph --out`, lore strings and the text of
any human-readable output. Their readers are this tool or a person, and they may change in any
release.

### 2. How it is held

Code → a generator → the observable surface → a comparison with `contract/surface.json`. The test
only compares and never writes the file. The file is updated by a separate command, and the diff that
command produces goes into the pull request.

The divergence between the generated surface and the recorded file is the mechanism, not a defect to
tidy away: a change to the surface is visible exactly because the two stop agreeing, and the update
command is the one explicit act that makes them agree again.

Two parts of the surface are not observable today and become so as part of this work, not as a
separate decision. The exit codes assigned inline in `src/cli.ts` move into per-command tables, as
`SYNC_EXIT` and `COST_EXIT` already are. And the command definitions move to a module the generator
can import without `runMain` running, which `src/cli.ts` does on import today.

**The key sets come from samples, not from types.** `costJson` and `syncJson` are declared as
`Record<string, unknown>` and add keys conditionally on state, so no type states their keys. The
other two are interfaces, but a type describes a declaration and not what is emitted, which is the
reason [0029](0029-an-acceptance-is-red-under-a-named-wrong-implementation.md) asks an assertion to
read an outside witness. So the generator runs each contracted command against one fixture per state
the output can take, and records the union of keys per state.

### 3. Changing the file proves nothing; the bump it implies is computed

A pull request that edits `contract/surface.json` has only shown that the surface changed. The bump
it requires is computed, and one rule covers every pull request, the version pull request included:

- **Required bump** = the semantic diff between `contract/surface.json` at the latest release tag and
  `contract/surface.json` at `HEAD`.
- **Declared bump**: on an ordinary pull request, the strongest level among the changesets in
  `.changeset/`; on the version pull request, the difference between the two versions in
  `package.json`.
- **Declared weaker than required → CI red.** There is no exception for any branch.

| Change | Required bump |
|---|---|
| a command, alias, flag, exit code, JSON key, path or marker removed or renamed; an exit code's value changed; a format version changed | at least **minor** before 1.0, **major** from 1.0 |
| additions only | any level |

A rename is a removal and an addition.

**The package version is not part of `contract/surface.json`.** If it were, the version pull request
would change the surface it is judged against, and the check would measure its own output. The
generator therefore reads nothing that `changeset version` writes.

### 4. Every contracted `--json` carries `schemaVersion`

The condition is membership in the contract, not a list of four commands decided separately. An
output that enters the contract gains a top-level `schemaVersion`, and a breaking change to its key
set raises it. The existing `version` field of `cost --json`, and `fromVersion`/`toVersion` in
`sync --json`, name CLI versions and stay as they are: they answer a different question.

### 5. `detach` reads `recordVersion`

A record declaring a `recordVersion` newer than this binary knows is refused and nothing is removed,
as [0022](0022-a-manifest-ahead-of-the-reader-is-a-state.md) does for the manifest. A missing or
non-integer `recordVersion` is refused as well, for the reason `excludeSeparator` is: it is not
guessed. A frozen record of version 1 enters `tests/fixtures/` and is never edited
([0021](0021-a-record-of-the-past-is-not-edited.md)).

## Consequences

The mirror tests that exist today stay: they catch a change made on one side. They stop being
mistaken for a contract.

Releasing a breaking change becomes a deliberate act in three places at once: the surface diff, the
update command's diff in the pull request, and a changeset of the required strength. None of the
three can be skipped without CI saying so.

The version pull request is not special-cased: it carries no changeset, so its declared level is the
version difference it writes, and it is judged by the same comparison against the last release tag.

## Boundary

The semantic diff sees shape, not behaviour. A changed default value, a key that keeps its name and
changes its meaning, or an exit code that keeps its number and changes what it reports all leave the
surface identical, and nothing here catches them. A green check means *the shape did not break*, not
*there was no incompatible change*. Those remain review (L1), and a changeset that calls one of them
out is written by hand.

## The prediction recorded before this draft

The prediction and the choice made after it answer two questions, so they are labelled apart.

- **Prediction:** *the generator will not get the key sets of `--json` from types without output
  samples.* **Partly confirmed.** Confirmed for `cost` and `sync`, whose outputs are declared
  `Record<string, unknown>` and add keys conditionally. Refuted for `doctor` and `soulkill`, whose
  key sets can be extracted from their interfaces.
- **Decision:** samples per state for all four, by
  [0029](0029-an-acceptance-is-red-under-a-named-wrong-implementation.md): a type describes a
  declaration, and the comparison reads what is emitted.

## Enforced by

| Point | Now | With the code |
|---|---|---|
| 1. What is inside | L1 review | L3: a test fails when a contracted item is missing from the generated surface. Outside items are named in the contract file, so moving one in or out is a diff |
| 2. Compare, never write | L1 review | L3 for the comparison. L3 lint for "never writes": a `no-restricted-imports` block on the comparison test forbids the `node:fs` write functions |
| 3. The required bump | L1 review | L3 when the job runs in `ci.yml`. **L4 when the owner makes that check required in branch protection**, which is an action outside this repository and not something the code can do; until then a red result can be merged past |
| 3. No package version in the surface | L1 review | L3: the generator run before and after `changeset version` produces a byte-identical `contract/surface.json` |
| 4. `schemaVersion` on contracted output | L1 review | L3: the generator fails when a contracted `--json` sample has no top-level `schemaVersion` |
| 5. `detach` reads `recordVersion` | nothing: the value is written and never read | L3: a test with a record one version ahead, a test with the value missing, and the frozen version-1 record read successfully |
