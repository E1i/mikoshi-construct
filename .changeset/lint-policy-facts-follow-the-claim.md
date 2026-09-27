---
"mikoshi-construct": patch
---

cli: with a harness command other than `pnpm run quality`, `construct.model.json` no longer carries the facts `lint-policy-test` and `lint-policy-test-loads-eslint`, which only the `lint-policy` claim stood on and which that harness leaves unwritten.
