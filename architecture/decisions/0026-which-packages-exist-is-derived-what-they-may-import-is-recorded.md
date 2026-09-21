# 0026 — Which packages exist is derived; what each package may import is recorded

Status: accepted · 2026-09-22

## Context

The monorepo preset computes two template variables from the tree on every `init`:
`workspacePackages` and `allowedWorkspaceImports`. Observed by construction on a tree the construct
materialized from empty, then re-inited:

```
run 1   'packages/shared': []
run 2   'packages/shared': ['@x/api']
```

`eslint.config.mjs` already exists on the second run, so it is skipped and the file keeps the strict
policy. The record and the file now disagree. `sync` reads that path as `update`, and `sync --apply`
resolves the disagreement in the file's direction by writing the record's looser policy into it —
confirmed by running it, not inferred. A dependency policy loosens on a repository nobody edited.

**One variable answers two questions.** Which packages exist is a fact about the tree. What each
package may import is a decision. Run 1 wrote `'packages/shared': []` — a leaf imports nothing, which
is an architectural position. Run 2 wrote the opposite position, which nobody took. The derivation
was never computing a policy at all: it computes a reasonable **default** for a tree that has no
policy yet.

So the derivation is right exactly once, at materialization, when there is nothing recorded and a
default is needed. After that the policy is the owner's, and re-deriving it is the construct
overwriting something it does not own. That is the shape
[0013](0013-a-second-init-adds-to-the-record.md) settled for the record as a whole and
[0006](0006-the-init-manifest-is-frozen.md) before it: the record is the authority for what was
decided, and the tree answers what exists, not what is allowed.

**A correction to the account this record was opened on.** The run is not silent about the change.
`recordVarsChanged` has named every changed variable with both values since 0013, and since the
output ordering changed it prints ahead of the list of paths. Measured on a re-inited monorepo, the
second run prints `allowedWorkspaceImports` with the old and new maps in full.

So the defect was not invisible. It was **read and not understood**: the output named a change to a
variable and did not name what that change would do. A reader who sees both maps in full still cannot
derive from them that `eslint.config.mjs` was skipped, that the record and the file therefore
disagree, and that a later `sync --apply` will close that gap by loosening the file. Every clause
printed was true and the reader's next action was still wrong — the same shape as a `doctor` line that
correctly reported a claim's facts as holding and let an adopter conclude that running `init` would
record it.

**Naming both values is necessary and is not sufficient.** A delta is not the message; the message is
what the delta will cause. That is the requirement this record carries, and it is more general than
the variable it was found on.

## Decision

**The key set is derived from the tree on every run. The allowances of a key already in the record
are never re-derived.**

- Every run derives which workspace packages exist. A package the owner added since the last run
  appears as a new key.
- A key already present in the recorded `allowedWorkspaceImports` keeps its recorded allowances, byte
  for byte. The construct does not recompute a decision it did not make.
- A new key is given a default, and the default is the one the preset applies to a package of that
  kind when it creates a workspace of its own.
- A run that changes a policy variable names both values **and what the change will do** — which
  file now disagrees with the record, and what a later `sync --apply` would write into it. Naming
  both values already holds; naming the consequence is the part that was missing, and it is the
  requirement rather than the delta.

Widening and narrowing stop being separate cases. There is no direction to detect, because a recorded
value is not touched — no flag, no prompt, and no asymmetry between the two directions.

**The default for a new key, measured rather than assumed.** `renderWorkspacePolicy` has two
branches, selected by whether any workspace package was detected. Over a fixture carrying
`apps/api`, `apps/web`, `packages/shared`, `packages/catalog` and `services/worker`, they differ only
for packages outside `apps/`:

| package | no package detected | packages detected |
|---|---|---|
| `apps/*` | every other workspace package | every other workspace package |
| anything else | nothing | every other workspace package |

The kind default is therefore the first column: a package under `apps/` may import every other
workspace package, and a package anywhere else may import nothing. It is the narrower of the two, and
it is what the preset asserts about a package whose role it placed itself. A package in a directory
the preset does not recognise falls to `nothing`, which is the safe side for a policy.

**What this record does not settle.** The measured default lets an app import another app. That is
what the preset computes today; whether it is right is a separate question, and this record fixes
only that a new key's default is not broader than what the preset already gives a package of that
kind.

## Consequences

Checked against the case that produced this record: `packages/shared` is already in the record, so
`[]` survives every later run. The packages the first run created are already keys too. A package the
owner adds afterwards arrives as a new key with its kind default and is named in the output.

**The cost of simply freezing the variables disappears.** A repository that legitimately gains a
package picks it up, because the key set is still derived. Freezing `vars` wholesale would have left
a new package outside the policy with no way in but editing `construct.json` by hand.

**This narrows 0013.** That record says `vars` comes from this run, which is how someone adds a
Cursor target or turns review on by re-running `init`. Policy variables are the exception, and the
reason is the one 0013 itself gives for every other branch: a later run does not cross out what an
earlier one recorded. The general rule stands; this names the class that leaves it.

**A constraint on the implementation, not a choice left to whoever picks it up.**
`allowedWorkspaceImports` is recorded as rendered JavaScript source, not as structured data, because
`vars` is `Record<string, string>`. Keeping a recorded key's allowances therefore has two routes, and
they are not equivalent. **The structure is recorded beside the rendered form; the map is not parsed
back out of the source.**

Parsing would make the rendered artifact the authority on what was decided. That is the coupling
broken when `init` stopped choosing the `AGENTS.md` template form from whether the file was on disk
and started reading it from the `variants` branch that
[0013](0013-a-second-init-adds-to-the-record.md) already required the record to carry: the record
decides and the render follows, never the other way round. A policy recovered by reading its own
output back is a policy whose source of truth is a formatting function. Where the rendered form and
the recorded structure disagree, the structure is right and the render is regenerated from it.

## Enforced by

**Nothing yet — L0.** This record is the decision; the implementation and its test are not in the
tree. Stating that plainly is the honest answer rather than naming a level this record does not have.

It becomes L3 when a test asserts, over a tree materialized from empty and re-inited: that a key
recorded with `[]` still reads `[]` after the second and third run; that a package added between runs
appears as a new key carrying its kind default and no wider; and that the run names the change with
both values **and with what it will do to the file the variable governs**. Until that test exists,
the behaviour described above is not the behaviour of the tool.
