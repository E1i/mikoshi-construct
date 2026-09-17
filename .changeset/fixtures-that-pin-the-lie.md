---
"mikoshi-construct": patch
---

Six fixtures for `doctor` under `tests/fixtures/doctor/`, written before the checks that will read them and asserting the wrong answer on purpose. Five repositories are objectively broken — an eslint config that never loads the construct policy, construct tests outside the runner's globs, a quality script that is red on a clean checkout, a quality script no workflow runs, a command with no hook to run it — and today `doctor` calls all five healthy. Each test says so in its title. A fixture written after the check can only confirm what the check already does; a fixture written first has to reproduce the lie. The expectations sit in one table keyed by the fixture directory, and a cross-check fails when a fixture has no row or a row has no fixture, so a check can never arrive without something that proves it can fail.
