---
"mikoshi-construct": minor
---

templates: `/plan` outputs each ladder-path task as the full skeleton of its brief — the `/implement` line, `Effort:`, `Design:`, `Acceptance:` with a `— witness:` per item, `Invariants:` and `Immutable:` — in the shape the implement build parses, instead of a one-line task the build refused for having no `Acceptance:` section. `/plan` also states that a task is never done twice: the brief proves its witnesses executable and does not implement the task, and an implementation its author wrote anyway becomes the pull request with no Ghost launched.
