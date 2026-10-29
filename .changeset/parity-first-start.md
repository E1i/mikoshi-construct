---
"mikoshi-construct": patch
---

`init` pins `packageManager` to the pnpm on the path only when it is not older than the pnpm mikoshi itself pins (12.4.2); an older or missing pnpm pins 12.4.2. The monorepo preset's catalog no longer carries `@types/express`, `express`, `express-openapi-validator` and `light-my-request` when the sample app is not written, so its lint passes on a repository with no consumer of them. The `.gitignore` `init` writes ignores `.pnpm-store/`.
