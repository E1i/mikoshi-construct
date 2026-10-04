---
"mikoshi-construct": patch
---

ghosts: `pnpm ghosts:expect-sample --effort <e>` prints the brief's `expect:` line from the one sample the brief and the launcher use — the done runs of that effort that `parseLedgerLine` accepts — followed by its sources and every reason a row was left out. The class is optional. A missing ledger or journal, or a class no journal line carries, is named as the reason (`runs not recorded in <ledger>`, `class not recorded on <N> lines in <journal>`) instead of a bare `n=0`. Rows the parser rejects are counted and named (`<N> rows the ledger parser rejects not counted in <ledger>`). Briefs that counted raw rows printed n=64 where this line prints n=58 on the same ledger: the 6-row difference is exactly those rejected old-schema rows. `parseExpect` reads a forecast line that carries this tail.
