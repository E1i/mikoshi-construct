---
"mikoshi-construct": patch
---

`construct intake` counts a test that runs ESLint (it constructs `new ESLint(…)` or calls `calculateConfigForFile`) as covering a card that touches the root `eslint.config.*`, so that test goes into the card's runs instead of being missed.
