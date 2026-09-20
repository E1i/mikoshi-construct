---
"mikoshi-construct": minor
---

`init` now writes a second file beside `construct.json`: `construct.model.json`, a single
machine-readable model of what this tool holds to be true about a repository. Nothing reads it yet.
`doctor`, `sync`, the invariants table and every report work exactly as they did.

The two files are separate authorities and stay that way. The manifest records file provenance — what
`init` and `sync` wrote. The model records repository knowledge — what is claimed and how each claim
is held. Neither reads state from the other, and that is a lint rule running in both directions rather
than a sentence in a decision record: `src/model` cannot import `src/manifest.ts` and `src/manifest.ts`
cannot import `src/model`. The rule shipped in the same change that named the modules, because a plan
item promising enforcement later is itself only a promise.

Three properties of the model are worth stating, because each one is a thing the schema refuses rather
than a thing it offers.

There is no state stored anywhere in the file, and the parser rejects a `state` property at any depth.
A hypothesis is held by the facts named under it or it is not held at all, and that is computed on
every read. A hypothesis whose supporting file has been deleted reports `unsupported` without anything
having to notice the deletion.

There is no confidence field under any name — not `confidence`, `strength`, `score` or `support`.
Epistemic rule 7 separates confidence from evidence state, and a number beside a hypothesis is read as
a probability. Whoever wants one has to change the schema and defend it.

`unsupported` and `unknown` are different answers and the derivation keeps them apart. A fact that
could not be evaluated at all — an unreadable path, a directory where a file was expected — leaves the
hypothesis `unknown`. `unsupported` is reachable only when every named fact was actually evaluated and
at least one does not hold. Rule 2 again: not having looked is not a finding, and a negative verdict
needs full evidence exactly as a positive one does.

An enforcement carries the facts that hold its level up rather than a bare level, which is rule 8 taken
seriously — the presence of a mechanism is not the level at which it is enforced. A claimed L3 whose
workflow has been deleted stops being held, where a bare `"level": "L3"` could never rot.

The rule that picks where a chain stops being held ships here too, with the fixture that pins it, even
though nothing renders it until the next step. Ties are reachable, and declaration order breaks them,
because that is what stays stable in a diff.
