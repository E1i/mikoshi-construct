/implement Make the thing refuse (#1).

Effort: medium — one module, the design is written here.

Design:
- a line that says Acceptance: inside prose is not a label

Acceptance: the first item holds — witness: `test 1 -eq 1; test 2 -eq 2`; the second item (with a parenthesis) holds — witness: `node -e 'process.exit(0)'`

Invariants: `pnpm run quality` is green; nothing else changes (not even this)

Immutable: `src/a.ts`; `tests/b/`

Mutations (predicted before the run; applied afterwards):
M1 | src/a.ts | edit: something | red: W1