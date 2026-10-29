---
"mikoshi-construct": patch
---

`browser-lab.mjs --route <url-glob> <file>` now answers the matching requests of the extension service worker as well as those of the pages, and every command that opens the lab browser takes it, not only `page`: `sw-eval "fetch(…)" --route …` gets the file back. `hands` refuses `--route`, since its browser is opened by `@playwright/cli`. The lab opens its browser with `serviceWorkers: 'allow'` and without `PLAYWRIGHT_DISABLE_SERVICE_WORKER_NETWORK`, the two switches that would keep service worker requests off the routes.
