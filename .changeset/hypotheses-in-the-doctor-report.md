---
"mikoshi-construct": minor
---

`doctor` reads back what the construct was taken to be. The result gains a knowledge-family
`hypotheses` field: one entry per hypothesis in `construct.model.json`, carrying its statement, the
base it was read from, and the state derived from the facts named under it — held, unsupported with
the paths that no longer match, or unknown. The two ways of being unknown stay apart on the wire and
in the report: a hypothesis whose facts could not be read says so and names them, and a hypothesis
with nothing named under it says that instead of reading like a reading that failed. An empty list
never passes for a repository that was looked at and found standing, and a hypothesis recorded
against a tree with uncommitted changes is reported as one.

Two defects on the hypothesis path go with it: the derivation kept only the state and dropped the
reason, and it resolved with no facts in hand, so a fact that stopped holding was named by its id
instead of the path it points at.

The rule that a reading may not be worded as a verdict now covers hypotheses as well as claims, and
lives in one place both read from rather than in the test beside one renderer. It matters more here
than it did for claims: `unsupported` on a claim is a statement about a mechanism, while on a
hypothesis it is a statement about what the repository is, so the false reading — *you are not that*
— sounds more confident than the true one, which is only that the ground under the interpretation
stopped matching. Both registers are held to it at the strings, because a rendered line in a test
resolves to the plain register whatever theme it asks for.
