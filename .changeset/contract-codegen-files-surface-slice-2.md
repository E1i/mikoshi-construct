---
---

The boundary code of the contract files and the commands in `scripts/contract/surface.ts` is now the text that `contract/surface.json` generates: `SURFACE_VERSION`, the format versions of `construct.json`, `construct.model.json` and `.construct/attach.json`, the list of commands, and the reader of a format version. `scripts/tests/contract/codegen-files-surface.test.ts` fails when that code drifts from the contract or from the versions the writers stamp. It also proves that each of these contracts carries a version that the compatibility gate holds: a format version that grows, or a command that is removed, needs a minor changeset, and a surface of another `surfaceVersion` is regenerated and never read as the base.

The card report is a contract file too: `contract/surface.json` records it in a `report` section with its own `reportVersion`, and the count line `■ n □ n · n` is required in a report whose change touches `src/` or `templates/`. The generated `REPORT_CONTRACT` and `reportWithoutCountLine` agree with the reader the merge uses to withdraw a pull request as `no_matrix_count_line`. A change to the report contract that does not grow its `reportVersion` is refused.
