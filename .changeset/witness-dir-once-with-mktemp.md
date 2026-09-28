---
"mikoshi-construct": patch
---

templates: the `/implement` ladder's verify prompt now names the witness scratch directory once, up front — "Make `<dir>` once, before the first witness, with `mktemp -d`, and write the absolute path it printed wherever `<dir>` stands: it lies outside the repository, so it still resolves after the `cd` into the base worktree and adds no file to the working tree" — instead of the single "in a scratch directory of your own, `<dir>`", which said where the scripts go but not how or when to make that directory; `.claude/agents/harness.md` says the same. A brief's empty `Design:` section (`design: ""`) no longer puts a `Design from the brief:` block into the architect's or the implementer's prompt, and the build's `Design:` label counts only at the start of a line, so one written mid-sentence stays plain text.
