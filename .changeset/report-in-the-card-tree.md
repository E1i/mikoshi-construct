---
'mikoshi-construct': patch
---

factory: a shift session now writes its report to `.construct/report.md` inside its own card tree, which it can always write, instead of to the bus's launch directory, which a sandboxed session could not reach. The bus collects the report out of the tree before anything is staged, so the commit never carries it, whatever the repository's `.gitignore` says; it saves it where `finding:` and `question:` lines were always read from, and puts it back into the tree before a continued session. The launch shell records the session's exit code. A cheap card whose session ended with no report, or an empty one, stops with `card.stopped` code `report-missing`, naming the tree path and the exit code, and tree-pr refuses the same way instead of opening a pull request.
