---
"mikoshi-construct": patch
---

Four manifests written by 0.1.0 and 0.1.1 are frozen as fixtures, with every name replaced. They are valuable precisely because they cannot be generated: today's code produces today's manifests, so every fixture written here tests the replay against records the current templates could have made. In the wild there are records made by versions that no longer exist, and now four of them are covered.

What is kept is the shape — how many packages a workspace has, what roles they play, which may import which, which variables the version of the day recorded. What is replaced is every project name, scope and package name, because a repository's own names belong to its owner and one of these carried the names of other people's companies. The recorded hashes are meaningless after that replacement and the accompanying note says so, so that nobody later compares a rendering against them or edits the fixtures toward more realism.

The privacy guard, which scanned `templates/`, `docs/` and `README.md`, now scans `tests/fixtures/` too — the place these records live and the one place it was not looking. A test asserts that every scope inside a frozen manifest belongs to that fixture's own invented project, so a name from somewhere else fails the suite rather than waiting to be noticed in review.
