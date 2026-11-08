---
'mikoshi-construct': patch
---

The factory contract's `owner-commands` count no longer counts a command the code runs itself. A pnpm or construct command line is left out when it is an argument of a call that runs a command (a function named `exec…`, `spawn…`, `run…` or `shell…`, or a method named `exec…`, `spawn…` or `shell…`), when a generator yields it to its runner, or when it is a constant the file passes to one of those. A command shown to the owner in a message, a usage line or a bound statement parameter is still counted. `overlaps:owner-commands` goes from 179 to 174: the two `pnpm install --frozen-lockfile` the witness runners run, the eslint command `scripts/ports/witnesses.ts` yields, and the `pnpm run quality` harness argument the surface and JSON-sample scripts pass to the CLI.
