---
'mikoshi-construct': minor
---

The harness agent reads a pytest skip or expected failure added to a test as a weakened test: `@pytest.mark.skip`, `@pytest.mark.skipif` and `@pytest.mark.xfail`, with or without parentheses, and `pytest.skip(` / `pytest.xfail(` calls. Before, only `.skip(` and `.only(` were named, which a bare `@pytest.mark.skip` does not match.
