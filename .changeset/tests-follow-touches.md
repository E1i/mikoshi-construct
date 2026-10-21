---
"mikoshi-construct": patch
---

cli: `construct intake` adds to a card's touches every test that imports a touched file, directly or through other modules, and for `package.json` the tests that read its scripts, without asking a person to confirm. A directory with more than six such tests is added as one `<dir>/**`. These tests do not count toward the "more than 6 touches" signal that proposes cutting a card into slices.
