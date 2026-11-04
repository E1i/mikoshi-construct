---
"mikoshi-construct": patch
---

cli: `construct init` records how the repository brings its server up as `serve: { command, url, readyTimeoutMs }` in `construct.json`, from the preset's default: `pnpm dev` on port 3000 for `node-backend` and `monorepo`, on port 5173 for `node-frontend`, and nothing for `node-library`. A repeated `init` keeps the `serve` the repository declared, and a malformed one is dropped on read.
