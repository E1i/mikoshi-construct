# Tests

- Tests never sit next to source. `src/` stays product-only; unit tests live in `<app|package>/tests/**`
  mirroring the `src/` layout, named `*.test.ts` (Vitest).
- End-to-end and API integration specs live in a top-level `e2e/` directory as `*.spec.ts` (Playwright).
- Every new or changed logic module ships with its matching test file in the same PR — not a follow-up.
