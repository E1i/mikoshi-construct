---
"mikoshi-construct": patch
---

An open question: the machine-readable output declares nothing and refuses nobody

`construct.json` declares `manifestVersion` and `construct.model.json` declares `modelVersion`, and each
refuses a record written by a later build through one shared error. `doctor --json` declares nothing:
`src/cli.ts` serialises `DoctorResult` as it stands, so the output carries no statement of what it is
and there is nothing for a reader to check or for the tool to refuse. A consumer matching a value that
has since changed — `authorship: "unknown"`, which 0.16.1 no longer emits — receives no error; its
branch simply stops firing.

The question is recorded in this repository's `open-questions` marker with the measurement behind it:
nothing the construct materializes calls `doctor --json` — not the templates, not the workflows, not
`construct-discover.md` — and every match outside the source is built documentation or release-note
prose. The consumer count is zero today, and that is what makes an answer cheap now rather than what
makes it unnecessary.

No design is proposed and no code changes.
