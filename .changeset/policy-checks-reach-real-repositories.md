---
"mikoshi-construct": minor
---

The lint policy checks never reached a real repository. They lived in each preset's `sample` group, and a sample is materialized only into an empty directory — so `init` against a repository that already has code, the case this tool exists for, wrote the policy and skipped the test that proves it fires. `doctor` had been reporting `lint-policy L0 absent` and was right. The tests now ship in `baseline`, and arrive whether the directory is empty or not.

`node-frontend` declared three restrictions and shipped no test that any of them fires; it now has one, and the restrictions cover their class — a computed member reaches the same method, and binding an element's `classList` or `style` to a local name steps around a selector matched on the member expression. Reverting any of them to its narrow form fails the new tests.

`node-library` is deliberately untouched and still reports `lint-policy L0 absent`. It declares no syntax policy — its groups are the base and the harness, and the harness config carries no restriction of the construct's — so `absent` is a true reading rather than a missing file, and `docs/cli.md` now says so where the check is documented. Manufacturing a policy so that a report turns green is the defect this tool exists to find.
