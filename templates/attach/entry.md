# Attach entry protocol

You are the agent about to attach the construct's /plan and /implement carriers to this repository. The one thing attach cannot know is the harness command the ladder verifies every change with. Read the repository, propose one command, and let the owner answer yes or no. Write nothing, install nothing, commit nothing while you do.

## Where the tree stands

- `git status --porcelain`: say what is modified or untracked. Do not clean, stash or reset anything.
- The current branch, and its upstream through `@{upstream}`.
- Ahead and behind as last fetched: `git rev-list --left-right --count HEAD...@{upstream}`. The first number is what this branch has and the upstream lacks, the second is the reverse.
- The age of that reading is the modification time of `.git/FETCH_HEAD`; say when it is older than a day, or absent.
- Fetch only when the owner says yes: git fetch rewrites the remote-tracking refs. Run no fetch otherwise.

## What an earlier construct left

Look for `.construct/`, `.claude/`, `.cursor/`, `scripts/construct/` and `construct.json`.

- When `construct.json` is here, or `.construct/attach.json` is here, attach refuses this tree. Say so, propose nothing and ask nothing. An attached tree is cleared by `npx mikoshi-construct detach`; a tree with `construct.json` is not attach's to touch.
- When attach has refused on a collision, each path it prints carries one of two labels. construct's own: byte for byte a carrier template of an earlier construct run, so deleting it loses nothing the construct cannot write again. not recognised: attach never writes over it, so it is the owner's; never delete a file labelled not recognised and never put one on a delete command.
- Attach writes over nothing, not even its own earlier files. The refusal prints the one command that deletes only what is construct's own and runs attach again; give it to the owner as printed.

## What CI runs

Read every CI definition whole: `.github/workflows`, `.gitlab-ci.yml`, and any other pipeline file the repository carries. For each job that runs on a pull request, list its commands in order and what they need first: a service, a secret, a build output, an installed toolchain.

## What the toolchain needs

Dependencies are resolved for one interpreter, and the machine may hold another. Before anyone runs an install, name the interpreter the repository wants and what building its lock needs, so the first install is not the one that finds out. This section is written for Python; ask the same questions of any other language in its own terms.

Search every directory that holds a Python project, below the root as well as at it: a `backend/pyproject.toml` counts as much as one at the root.

Exact sources name one interpreter:

- `.python-version`
- `.tool-versions`
- `runtime.txt`
- `python-version` of `actions/setup-python` in a CI workflow
- `FROM python:<X>` in a `Dockerfile`
- `python=` in a conda `environment.yml`

Range sources name a bound, not an interpreter:

- `requires-python` under `[project]` in `pyproject.toml`
- `python` under `[tool.poetry.dependencies]` in `pyproject.toml`
- `python_requires` in `setup.cfg`
- `python_requires=` in `setup.py`
- `python_version` under `[requires]` in `Pipfile`
- `envlist` in `tox.ini`
- `requires-python` in `uv.lock`
- `python-versions` under `[metadata]` in `poetry.lock`

An exact source wins. From a range, name its lower bound and say why: a lock written years ago was resolved against that bound, and the newest interpreter on the machine may have no wheels for what the lock pins. Example: `python = "^3.10"` with a 2023 lock means 3.10, and Poetry picked 3.13 and failed on pillow 9.4.0.

Say at once, before any install:

- the version, and the file and line it came from;
- what is on `PATH`: `python3 --version`, and whether `python3.X` resolves;
- the command that makes the project's own manager use that interpreter: `poetry env use python3.X`, `uv python install 3.X` or `pyenv install 3.X`.

Name the interpreter as `python3.X`. Where it is missing, that is the Homebrew formula `python@3.X` on macOS, and a distribution package or pyenv on Linux. Install nothing: name the command and leave it to the owner.

Native dependencies come from the lock, not from a list of package names kept here. A package whose lock entry carries no wheel matching the named interpreter and this platform, only a source distribution, builds from source: read `files` in `poetry.lock`, and `sdist` and `wheels` in `uv.lock`. What that build needs is taken from the package's own installation documentation, cited by link, never from memory. Also compare architectures: `uname -m` against `file "$(command -v pg_config)"`, or against the build tool that documentation names. A build tool of the other architecture on `PATH`, such as an x86_64 `pg_config` from `/usr/local` feeding an arm64 build, fails the install on the machine, not on the project.

A `requirements.txt` with no lock behind it: say "not determinable from a lock". The check is `pip download --only-binary=:all: --python-version <X.Y> -r requirements.txt -d <tmp dir>`. It needs the network, so it is a check the owner may run, not one you run without a yes. Verified on 2026-10-03 with pip 26.2.1 on macOS arm64:

- It fails with `No matching distribution found for <pkg>` on a package with no wheel, and builds nothing: no "Building wheel" line, nothing saved.
- Without `--python-version` it judges by the interpreter pip itself runs on and gives a false result: pillow 9.4.0 fails on 3.14, and with `--python-version 3.10` it saves a cp310 wheel.
- It stops at the first package without a wheel: with psycopg2 and then lxml 4.9.2 in the file, only psycopg2 is named. It proves that at least one package builds from source, not the full set.

## What the repository can run

- Every `package.json` scripts block, in every workspace package.
- `Makefile`, `pyproject.toml` and the other task and test configs the languages here use.
- The hooks in `.husky/`, `.pre-commit-config.yaml` and the non-sample files in `.git/hooks/`.
- Every README, read whole: they name the commands the maintainers say to run.

## The test surface

Give one table, headed `Suite | Runner | Where | Run by CI`. One row per suite, with the last column holding the job and step that runs it, or `not run by CI`.

A suite CI does not run is listed in the table and is never added to the proposal. After the table, print those suites again in a list headed `Not run by CI:`, one line per suite, each with where it lives.

## The proposal

Propose exactly one command, in one form. There is no second form that adds the suites CI does not run.

- It mirrors the CI jobs, in order.
- It leaves out builds whose output nothing checks, image builds, deploys, publishing, and steps that need a secret or a service that is missing. Name each one left out, with why.
- Its first word is on `PATH`; a package script name or a binary under `node_modules/.bin` is not. Write the runner in front of it.
- It carries no `:fix` script, no `--fix` and no `--write`: the gate checks, it never edits.
- Do not run it to find out whether it passes.

## The question

Ask the owner one question, answered yes or no: run this command as the harness?

- yes runs `npx mikoshi-construct attach --yes --harness "<command>"` with the command you proposed.
- no means attach is not run.

Write nothing, install nothing, commit nothing.
