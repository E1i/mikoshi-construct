---
"mikoshi-construct": patch
---

templates: the /implement ladder extracts each witness by its sha256 instead of its position, so a handle that drops or reorders a criterion no longer runs another criterion's command; check-acceptance witness takes --witness-sha256 in place of --n
