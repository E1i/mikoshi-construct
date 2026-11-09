---
'mikoshi-construct': patch
---

The board page reads its style and its script from static files beside it, `scripts/cli/board-page/style.css` and `scripts/cli/board-page/script.js`, which ship with the factory build; the script gets the page's names as data when the page renders, and `board-page.ts` drops from 1940 lines to 1280.
