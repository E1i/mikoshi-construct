---
"mikoshi-construct": minor
---

templates: the `/health` tests that `construct init` writes for `node-backend` and the `monorepo` API now call the Express app in memory through `light-my-request` instead of `supertest`. `supertest` opens a port on 127.0.0.1, which a sandbox without local binding refuses with `listen EPERM`, so `pnpm run quality` failed inside an agent's sandboxed session. The three tests check the same things: 200 with the exact body and no `x-powered-by`, 503 when the probe fails, 404 outside the contract. `supertest` and `@types/supertest` leave the generated manifests and the monorepo catalog. A repository already initialised keeps `supertest` until you change `tests/health.test.ts` and its `package.json` by hand.
