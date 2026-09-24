---
"mikoshi-construct": minor
---

templates: `/implement` copies an agreed `Acceptance:` section into the ladder's arguments verbatim and checks it with `scripts/construct/check-acceptance.mjs` before calling the ladder, stopping when an agreed item dropped out; the ladder logs the acceptance it received and echoes it as `acceptance` on every result, and `construct attach` now writes the check as a seventh file.
