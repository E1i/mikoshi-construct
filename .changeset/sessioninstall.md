---
"mikoshi-construct": patch
---

The bus now installs a card tree's dependencies outside the sandbox (`pnpm install --frozen-lockfile --prefer-offline --ignore-scripts`) before every card session and every answer session, as the reviewer already did before a review.
