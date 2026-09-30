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
