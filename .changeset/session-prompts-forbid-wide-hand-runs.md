---
'mikoshi-construct': patch
---

Card sessions no longer hand-run whole test directories. The launch header and the answer prompt both state the rule: run by hand only the witness tests and the tests of the touched files, prepush and CI run the rest, never pass whole test directories to vitest. The settings every card session is spawned with install a PreToolUse guard on Bash (`scripts/ports/wide-vitest-guard.ts`) that refuses a vitest command naming no test file or more than 3 test directories, and names the rule in its refusal; a vitest command over test files runs as before.
