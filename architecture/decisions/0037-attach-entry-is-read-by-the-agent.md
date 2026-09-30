# 0037 — attach entry is read by the agent

Status: proposed · 2026-09-30

## Context

`attach` needs one input it cannot know: the harness command the ladder verifies every change with.
0034 settled that attach does not read the stack, and 0015 that anything needing judgement is the
agent's. So the reading that turns a repository's CI, scripts, test configs and hooks into one command
has no owner: `--yes` without `--harness` is refused with one line, and the person is left to guess
what to pass. Separately, a rerun after an earlier attach stops at a collision that prints bare paths,
with no way to tell the construct's own earlier files from the owner's.

## Decision

1. **The agent reads the repository on entry; the CLI prints how.** `attach --entry` prints the
   protocol in `templates/attach/entry.md`, the only place it lives, and exits 0. It reads no
   directory, runs no refusal and writes nothing, whatever other flags are given, so it works in a
   directory that is not a repository. The agent follows the protocol, proposes exactly one command,
   and asks one question answered yes or no. Yes runs attach with that command; no means attach is not
   run.
2. **Nothing of this enters `src/detect`.** Mirroring CI is interpretation. `src/commands/attach`
   still imports only `isEmptyDir` from `src/detect`, and the no-harness refusal gains a why and a next
   step that name `attach --entry` instead of a guess.
3. **The known set.** `templates/attach/earlier-carriers.json` lists `{ target, sha256, date }` for
   every template a carrier ever had. `scripts/attach/earlier-carriers.ts` is its only writer: it reads
   history, only adds, and dates each blob by the first commit that carried it. Its `--check` names
   each pair history or the working tree has and the file lacks, and each the file has that neither has.
4. **A byte comparison is a fact that decides no write.** On a collision attach hashes each colliding
   carrier path with sha256 and labels it construct's own (same target, same sha256) or not
   recognised (anything else: changed bytes, another carrier's template, a symlink, a directory). The
   label only chooses the wording and the printed command; attach still writes over nothing. The one
   printed command deletes only the recognised files and runs attach again, and a file not recognised is
   never on it. attach gains no flag but `--entry`.

## Consequences

- An agent entering a repository has a protocol to follow, and the owner has one question to answer.
  Whether a proposal mirrors what CI runs is not checked by the tool.
- Attach writes nothing over an owner's file or its own. Clearing the way is the owner's act, through
  the printed command.
- `--check` needs full history, so it runs by hand and is outside `pnpm run quality` and CI, which clone
  shallow. A branch that commits a carrier template twice and runs the generator afterwards leaves a
  pair a squash merge removes from history, and `--check` then names it.
- A repository already attached (`.construct/attach.json` present) still gets the delete-and-rerun
  command where `construct detach` is the better answer. The protocol tells the agent to name detach in
  that state; what the CLI says there is a follow-up.
- The printed command quotes a path or harness with JSON quoting, which does not escape `$` or a
  backtick. That matches the existing not-a-command next step and is accepted.

## Enforced by

- L3 tests: the protocol printed whole, what it names, and the no-harness refusal in both themes
  (`tests/attach-entry.test.ts`); the known set, the classification and the delete-and-rerun command
  (`tests/attach-earlier-carriers.test.ts`); the generator's grow and drift
  (`scripts/tests/attach/earlier-carriers.test.ts`).
- Lint: `src/commands/attach/**` may import nothing from `src/detect` but `isEmptyDir`
  (`attachDecidesWithoutTheStack` in `eslint.config.mjs`).
- L1 review: whether an agent's proposal mirrors what CI runs.
- The generator's `--check`, run by hand only.
