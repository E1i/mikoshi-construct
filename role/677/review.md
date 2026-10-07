# Review of #677 detach-no-trace-guest-runs (R1) at head 4fedc077100f3f881c9fdb0fdc78027785ad2f5d

Verdict: pass-with-notes (candidate: approve-with-notes)

## Design walk
- Ownership: `classifyRuntime` (src/commands/detach/runtime.ts) removes a run in a held browser only when `ledgerHeld` is an array, `browserHeld` is an all-string array and the run name is absent from it. No clock. A record without `browserHeld` yields null -> none removed. `.construct/browser` itself goes only when `browserFree`. The name regex, directory, all-png and not-tracked filters are kept.
- Attach: `browserEntriesHeldAtAttach` records sorted names before any write; `[]` when the directory is absent. `recordVersion` stays 2; the record gains only `browserHeld?: string[]`.
- Restore line: `takeOutGuardEntry` returns `bytesRestored`; exactly one of `detachEntryRemoved` and `detachOriginalRestored` prints. The new lore line has its PLAIN_LORE twin and is not counted in `detached(n)`.
- Touches: every changed file is inside Design 1. One new minor changeset. No comment added. Tests are only in tests/. No `recursive|force|glob` in src/commands/detach.
- Existing test lines changed: exactly 2 (the node:fs import and the moved `await attached(dir)`).

## Commands (head 4fedc07 unless stated)
- pnpm install --frozen-lockfile -> exit 0
- Acceptance witnesses (vitest -t ..., count of check marks), all 1: guest-runs removal, original-bytes line, attach records names, fresh-mtime stays, record without browserHeld, changed existing test stays
- changeset witnesses: 1 added file, minor present; touches witness: nothing outside; added-comment count 0; record.ts diff is exactly `+  browserHeld?: string[]`; ATTACH_RECORD_VERSION = 2 present
- NO_COLOR=1 pnpm exec vitest run tests/detach.test.ts tests/attach.test.ts -> exit 0, 2 files, 124 passed
- pnpm typecheck -> exit 0
- pnpm lint -> exit 0
- Red on origin/main (ab581d8, head's two test files copied in): 'removes the run directories the guest created...' -> exit 1, 1 failed; 'says the original bytes came back...' -> exit 1, 1 failed. Both red as required.
- pnpm exec tsx scripts/attach/earlier-carriers.ts --check -> exit 1 at head, and exit 1 on origin/main too
- pnpm contract:bump -> exit 1 at head, and exit 1 on origin/main too
- pnpm run quality was not run (not requested).

## Notes
1. scripts/attach/earlier-carriers.ts --check - exit 1 at head and on origin/main: output "in the file, in neither history nor the working tree: <path> <sha>". The clone is shallow (`git rev-parse --is-shallow-repository` = true), so history hashes are unreachable. Not evidence either way; the diff does not touch the carriers' list (only adds `browserEntriesHeldAtAttach`). CI on a full clone must confirm.
2. pnpm contract:bump - exit 1 at head and on origin/main: "fatal: No names found, cannot describe anything." (no tags in this clone). Not evidence; the diff changes no command or flag. CI must confirm.
3. src/commands/detach/runtime.ts:75 - latent narrowness only: a name in `browserHeld` is kept even when the guest later adds a png to that pre-attach run directory. This is the intended reading (pre-attach entries stay). No failing input; informational.

No defect found in what detach removes: a pre-attach run directory (any name, any mtime) stays; only run directories absent from the recorded list go.
