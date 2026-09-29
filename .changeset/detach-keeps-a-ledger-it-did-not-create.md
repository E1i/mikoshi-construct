---
'mikoshi-construct': minor
---

cli: `construct detach` removes `.construct/` only when `attach` created it. `attach` records this as `ledgerCreated` in `.construct/attach.json`. Before, detach removed an empty `.construct/` that already existed before attach, a directory it had no record of creating. A record written before this field existed does not say, so detach leaves `.construct/` in place.
