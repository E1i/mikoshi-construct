# Engram — the model at version 4

Engram is `construct.model.json` at `modelVersion` 4. It describes any repository, attached or not:
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

## Older documents

A document that omits `stages`, `nodes` or `links` reads them as empty, whatever version it declares.
Versions 1 to 3 therefore still read, with the three lists empty. A build older than this one reads a
version 4 document as ahead of it, as [decision 0028](decisions/0028-a-model-ahead-of-the-reader-is-a-state.md)
describes.

## The alternative that was rejected

A separate `engram.json` would be a third record beside `construct.json` and the model. It would repeat
the evidence vocabulary (facts, `supportedBy`, the three states) and add a second version gate to read
before the first. One document with three more lists carries the same thing without either.

## Open question

Where an attached repository's Engram is written is not decided (#532). The owner's provisional
direction is outside the target tree, in `~/.construct`, with the same version 4 schema.
