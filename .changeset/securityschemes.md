---
"mikoshi-construct": patch
---

The generated contract security test no longer assumes a bearer scheme: every operation under `/v1/admin` and `/v1/me` must name a scheme the contract's own `securitySchemes` defines, whatever its type, and an admin operation must name the `admin` scope where its scheme marks one.
