[review:detach-no-trace-guest-runs]

Review 2 of #677 (PR #628) at head 38fd3f80e278c02e80cf4fc53377dd0517186dd0. Candidate verdict: pass. Review 1 (role/677-review) covered 4fedc077100f3f881c9fdb0fdc78027785ad2f5d.

## Delta against review 1
- merge-base with main: 4fedc07 -> ab581d88, 38fd3f8 -> 1e15c1a6.
- `git diff <merge-base> <head> -- src/commands/detach src/commands/attach src/ui/lore.ts tests/detach.test.ts tests/attach.test.ts .changeset` has sha256 3c537be03635087b87eb6d0ecb58dbd7aa7e9d24df75058005168079fd10274b at both heads: byte-identical. 10 files, 131 insertions, 11 deletions at both. The task's own files did not change; only main was merged in.

## Commands (head 38fd3f8, full clone, tags present)
- git fetch --unshallow --tags -> exit 0
- pnpm install --frozen-lockfile -> exit 0
- Acceptance witnesses of the brief, verbatim, with `HEAD` of each `git diff` replaced by the merge-base 1e15c1a (the PR is committed, the brief's witnesses assume an uncommitted tree): all 16 non-pnpm witnesses exit 0 (the 3 vitest counts of check marks = 1, changeset 1 added file with minor, 2 removed test lines, record.ts diff exactly `+ browserHeld?: string[]`, fresh-mtime, record without browserHeld, touched files, only the two allowed removed test lines, existing stays test, no recursive|force|glob, ATTACH_RECORD_VERSION = 2, added-comment count 0).
- pnpm exec tsx scripts/attach/earlier-carriers.ts --check -> exit 0
- pnpm contract:bump -> exit 0 (base v0.42.0, required patch, declared minor; the listed surface changes are intake flags that main brought in, not this PR)
- pnpm run quality as its own command -> exit 1 at once: `Error launching 'pnpm': Exec format error` (the pinned pnpm 12.4.2 tool copy under ~/.local/share/pnpm/.tools has a text placeholder in place of its binary, so the nested `pnpm` of the script chain cannot start; a PATH shim does not help because pnpm puts its own directory first). Not a reading of the tree.
- The eight steps of the quality script run one by one with `pnpm run <step>`: composition:check 0, model:check 0, privacy:check 0, lint 0, typecheck 0, test 1, docs:build 0, docs:pending 0, docs:anchors 0.
- test: 306 files, 305 passed, 1 failed; 3986 tests, 3969 passed, 15 skipped, 2 failed: scripts/tests/ghosts/cleanup.e2e.test.ts `l2` and `s2` (a ledger and a step cache made read-only with chmod 0o444 must refuse a write). The sandbox runs as uid 0, which ignores the mode, so the write succeeds. Rerun of that file alone: same 2 failed, 37 passed. The PR changes nothing under scripts/ (git diff 1e15c1a 38fd3f8 --stat -- scripts is empty). Not related to the task; it needs a non-root run to confirm.
- tests/launch-outlives-window.e2e passed in the full run (no rerun needed).

## Design walk (against the brief's Design 1-6, at 38fd3f8)
- 2 (attach records the list): `browserEntriesHeldAtAttach`/carriers.ts reads `readdirSync(.construct/browser).sort()` before any write; `[]` when absent; the record gains only `browserHeld?: string[]`; `recordVersion` stays 2.
- 3 (which run is the guest's): `classifyRuntime` in src/commands/detach/runtime.ts removes a run in a held browser only when `ledgerHeld` is an array, `browserHeld` is an all-string array and the run name is absent from it. No clock, no mtime, no attachedAt. A record without `browserHeld` gives null, so none removed. `.construct/browser` itself goes only when `browserFree`. The name regex, directory, all-png and not-tracked filters are kept.
- 4 (restore line): `takeOutGuardEntry` returns `bytesRestored`; the byte-restore branch returns `entryCutOut: false, bytesRestored: true`, every other branch `bytesRestored: false`; `runDetach` prints `detachOriginalRestored` on `bytesRestored` and `detachEntryRemoved` only on `entryCutOut`, so exactly one prints. The new lore line has its PLAIN_LORE twin and is not counted in `detached(n)`.
- 5 (changeset): one new `.changeset/detach-removes-guest-runs.md`, minor.
- 6 (the one moved test line): exactly the node:fs import and the moved `await attached(dir)` are removed lines in tests/.
- Touches: only the Design 1 files. No comment added. Tests only in tests/.

## Notes
1. `pnpm run quality` could not be run as one command in this sandbox (broken pinned pnpm copy, see above); the eight steps were run singly. Seven pass; `test` fails on two tests of an untouched script that depend on a non-root user. CI must give the single-command reading.
2. The brief at origin/role/677-brief:role/677/brief.md hashes to 162411bdcc5559beeb7d87ed4f627c7992527468077fe655ee6f413c10d88370, not to the 4d5dfcd3a7519c084c569c5a81d34e1394e68a9b5370a4f58cbc59acaeda16f5 of the verdict. The approved file `brief-677-detach-no-trace-guest-runs.md` was not in this clone, so the approved hash is taken from the prompt as given. `pnpm ghosts:verdict` will check it against the approval.

No defect with a concrete failing input found: a run directory present at attach (any name, any mtime) stays; only runs absent from the recorded list go.
