---
"mikoshi-construct": minor
---

doctor names the claims this preset can make and this repository does not carry

Since the birth gate, a claim whose evidence does not hold is not written — which left `doctor`
showing a short list and explaining nothing. It now names each claim the preset can make and the
model does not carry, with the first fact that does not hold:

```
Not claimed here: this preset can make these and this repository does not carry them. They have no
level, because nothing is enforced by a claim that was never made.
  no-committed-secret — .github/workflows/security.yml does not carry what it would stand on.
```

**Nothing about this is stored.** The expected set is rebuilt on every read from the preset and vars
already in `construct.json`, compared with the model, and evaluated against the tree by the same
machinery that evaluates the claims the model carries. No new entry, no schema change, no
`MODEL_VERSION` bump, nothing written by `init`. A trace would state what was true at `init` and go
stale in silence; a derivation stops being reported the moment it stops being true.

The expected set is what the preset **can** claim, not what one `init` materialized: `node-library`
ships no sample and therefore cannot make `lint-policy` at all, so its absence is a fact about the
preset and is never reported. An absent claim carries no level, sits in its own block, and changes no
exit code. Where the tree carries every claim its preset can make, nothing is printed.

Decision 0024 records it, and closes 0020's open question as incorrectly posed: the answer was not to
record the absence but that the absence needs no recording.
