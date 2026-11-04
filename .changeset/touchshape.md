---
"mikoshi-construct": patch
---

`construct intake` and `intake --admit` refuse a touch shaped like a package name (`@types/express`), a host (`registry.npmjs.org`) or a route (`/v1/health`) and name the reason, so a card's touches hold only repository paths. A path of that shape that exists in the tree or is listed under `creates` is kept, except a route, which is never a repository path.
