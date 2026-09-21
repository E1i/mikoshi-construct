---
"mikoshi-construct": patch
---

`construct graph` shipped in 0.10.0 and was documented in the CLI reference and the README command
table, and mentioned zero times in the walkthrough a new user actually reads. Reachable is not
discoverable — the same gap the release sidebar had. Getting started now ends on the picture, which is
the payoff of the walkthrough: `init` writes the files, `doctor` reports on them, and the graph shows
what those reports are read out of.

The example is the real rendering of a repository straight after `init`, not a sketch, and the
documentation site now renders Mermaid fences as diagrams rather than as source.

It also states the two things somebody meeting the model for the first time would otherwise discover by
surprise: a repository with no `construct.model.json` draws nothing and says so, and `init` is what
creates one.
