# Engram — the model at version 5

Engram is `construct.model.json` at `modelVersion` 5. It describes any repository, attached or not:
the facts, claims and hypotheses of [the model](model.md), and three lists that say what a repository
can do and where each ability stands on evidence. The vocabulary below lives in `src/model/schema.ts`.
This document is its second reader: `tests/engram-format.test.ts` reads the property lists from the
source and fails when a member is not explained here.

## Stages — the columns of the map

A stage is a named step of how a repository does what it does. It is document data: each repository
names its own, and the schema holds none. It is not one of the claim chain stages `enforcement` and
`verification` of [the model](model.md#chain-stages--where-a-claim-stops-being-held).

| Property | Meaning |
|----------|---------|
| `id` | The stage's name inside the document; unique among stages |
| `label` | What a reader sees for the stage |

## Nodes — the abilities

A node is one thing the repository does or holds, placed in a stage, with the evidence it stands on.

| Property | Meaning |
|----------|---------|
| `id` | The node's name inside the document; unique among nodes |
| `label` | What a reader sees for the node |
| `stage` | The `id` of a stage this document declares |
| `source` | Where the node lives: an object carrying exactly one of the keys below |
| `supportedBy` | The ids of the facts the node stands on; it may be empty |

## Sources — where a node lives

A source carries exactly one key. Both keys, neither, or any other key is refused.

| Property | Meaning |
|----------|---------|
| `path` | A path in the repository the node lives at; the schema does not check that it exists |
| `fact` | The id of a fact this document declares, whose path is where the node lives |

## Links — how nodes lead to each other

| Property | Meaning |
|----------|---------|
| `from` | The `id` of the node a link leaves |
| `to` | The `id` of the node a link arrives at |

## A node's state is derived

A node has no `state` in the file. On read it is derived from the facts in `supportedBy` through the
same `held`, `unsupported` and `unknown` states as a hypothesis, which
[the model](model.md#model-states--what-a-chain-of-facts-yields) explains. `source` takes no part in
it, and a node carrying a `state` property is refused as an unexpected property.

## Mechanics — what discovery found in the code

`mechanics` is the lower layer of the map: what discovery observed in the repository's tracked files,
without an LLM and without interpretation. It holds components and the relations between them, never
an ability: a component is not a node, it is never placed in a stage and it has no state. A relation
`a.ts ──calls──> b.ts` is a fact about the code, not evidence for a node. `mechanics` is optional;
discovery writes it, and a document without it reads as having none.

Every statement in `mechanics` has one of two kinds of source, and no third: a command and its exit
code (`identity`, `tree`), or a path and a line (each relation). Whatever discovery could not prove
carries the status `unknown` instead of a guess. The same repository at the same commit gives the same
bytes: no time, no absolute path and no order that depends on the machine enters the document.

| Property | Meaning |
|----------|---------|
| `identity` | The commit the observation was made at: `sha`, `status` and its command `source` |
| `tree` | The tracked file list the components were read from: its `status` and command `source` |
| `components` | The tracked TypeScript and JavaScript files, one per file, sorted by path |
| `relations` | The imports and calls found between components, sorted by the file and line they stand on |
| `sha` | The full commit sha `git rev-parse HEAD` printed, or null when it exited other than 0 |
| `status` | `found` when the source proves the statement, `unknown` when it does not |
| `source` | Where the statement stands: a command source or a line source, below |
| `command` | The command that was run, with its fixed arguments and no path of the machine |
| `exit` | The command's exit code, or null when it could not be started |
| `effects` | What the command ran, created or changed in the environment beyond its output; empty for a read |
| `line` | The 1-based line of `path` the relation stands on |
| `id` | A component's name inside the document: its path |
| `path` | The repository-relative path a component or a line source names |
| `from` | The `id` of the component a relation leaves |
| `to` | The `id` of the component a relation arrives at, or null when its specifier resolves to no tracked file |
| `kind` | `imports` for an import or re-export of a relative specifier, `calls` for a call of a name it imported |
| `specifier` | The module specifier exactly as the source wrote it |

A relation whose relative specifier names no tracked file has `to: null` and `status: unknown`. A
bare specifier (a package, `node:fs`) is outside the repository and is not recorded.

## Where an Engram is written

A repository made by `construct init` keeps its Engram in its own `construct.model.json`. An attached
repository's Engram is written outside the target tree, at
`~/.construct/engram/<repo>/construct.model.json` with `<repo>` the target directory's name, in the
same schema; discovery writes no byte into the attached repository, so its `git status` stays as it
was (the owner, 2026-10-05, #532).

## Older documents

A document that omits `stages`, `nodes` or `links` reads them as empty, whatever version it declares,
and one that omits `mechanics` reads as having none. Versions 1 to 4 therefore still read. A build
older than this one reads a version 5 document as ahead of it, as [decision 0028](decisions/0028-a-model-ahead-of-the-reader-is-a-state.md)
describes.

## The alternative that was rejected

A separate `engram.json` would be a third record beside `construct.json` and the model. It would repeat
the evidence vocabulary (facts, `supportedBy`, the three states) and add a second version gate to read
before the first. One document with three more lists carries the same thing without either.
