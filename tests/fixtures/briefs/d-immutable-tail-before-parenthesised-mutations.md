Make the rule reject the case (#256).

Effort: low — one rule, copied from its neighbour.

Acceptance: the rule rejects the case — witness: `pnpm vitest run tests/rule.test.ts`.
Invariants: quality stays green.
Immutable: `tests/rule.test.ts`; templates/. Mutations (predicted before the run): M1 | drop the check | red: the rule test
