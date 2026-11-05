# 0060 — The core talks to an agent client through one adapter contract

Status: accepted · 2026-11-05 · owner decision D-323, approved plan of factory-0.46.0 on card #1573

## Context

D-323: the core works with a session abstraction and names no agent client; Claude is the first adapter,
extracted one to one in behaviour and observability; client choice is configuration, added when a second adapter
needs it; the contract follows the factory's real needs, not a universal SDK. Today the bus, the ladder and the
window build `claude` argv at several points, and the same flags are written in each.

## Decision

1. The contract is `scripts/ports/client/contract.ts`; `clientAdapter()` in `scripts/ports/client/index.ts` is
   the factory, and it returns Claude until 0.47 switches it by configuration. A shared SDK, a transport, a plugin
   registry, a factory model catalogue and a second auto-selection are out of scope.
2. The adapter describes invocations and does not spawn. The lifecycle stays in the core: the detached chain with
   `tree-pr`, the exit-code file, the time ceiling, the pulse.
3. `Invocation.env` is what the client adds to the environment the core prepares, not a whole environment. The
   card variable, the removal of the owner's bus path and the colour variables stay with the core.
4. `session` in a `SessionSpec` is the core's id, the one the bus and the journal see. `identity: 'assigned'`
   means the client takes that id; with `'reported'` the adapter keeps the mapping to the client's own id.
5. `null` in a `SessionReading` means the client does not report the value, never zero.
6. An operation the client cannot do is an explicit `Refusal` with a reason. `invocation` refuses a resume of the
   `window` role, because the miko loop starts a fresh session from the handoff and no code resumes a window. A
   ladder resume is the `tree-pr` return, the one path that resumes a ladder card today. A review resume has no
   caller today and is described with the headless flags `resumeArgv` builds.
7. The flags a role passes today differ and stay different: `SessionPolicy` carries `profile` (`sandboxed` is the
   shift settings, `client-default` none) and `mcpOff` per call, because a ladder start and a window run with
   neither today.

## Selection of the client and the model

Designed in 0.46, switched on in 0.47. Nothing below runs before 0.47, and 0.47 enters the bus only after 0.46.0
is out.

- `init` allows a choice of client and model. `attach` keeps the choice recorded in the repository and sessions
  inherit it, with no silent switch.
- The record is a `client` branch in `construct.json`: `{ id, model, roles: { launch, answer, review, window } }`,
  a branch beside `sync` that `sync` does not overwrite. A session reads it at its start. No record means Claude
  and `auto`.
- `auto` is the existing mechanism and nothing new: the path comes from MORSE, the effort from the brief and the
  agents' frontmatter, and the review model from `CONSTRUCT_REVIEW_MODEL`. For Claude, `auto` is an empty pick, so
  no `--model` flag. There is no second model-selection mechanism.
- The model catalogue and real availability belong to the adapter, through `models()` and `modelFor()`. A list is
  not availability: `gpt-6-astra` was listed by a client and refused at launch. So a refusal is explicit, at
  `modelFor` where the adapter can tell and at the session's start where only the client can, and a card with an
  unavailable model does not start.

## The existing `ai` field

`ai` (`AiTarget` in `src/presets/index.ts`, recorded in `construct.json`) answers a different question: which
agent carriers `init` materialized, and it can be `both`. `client` answers which client the factory's sessions
run on, and it names one per role. So `ai` is kept and is not overloaded:

- `ai` stays what it is, the carrier record of `init`, frozen by 0006. `sync` and the template replay keep reading
  it.
- `client` is a new branch, and in the absence of `client` the sessions are Claude, whatever `ai` says. `ai`
  alone never moves a session to another client, and writing `client` does not rewrite `ai`.
- A `client.id` whose carriers `ai` did not materialize is a refusal naming both values, never a silent write of
  carriers. Which of the two changes then is the person's choice.

## Carried over to 0.47

- C12: `src/commands/attach/carriers.ts` passes `ai: 'claude'` to `planMaterialize`. That literal moves to the
  card `clientconfig` in 0.47, and it stays allow-listed by the seal until then, with every carrier under
  `templates/ai/claude`, which are Claude-adapter carriers delivered to other repositories.
- Which token, spend and context figures a client without a money cost shows, and the Codex and Cursor rows, are
  the cards of 0.47 and 0.48 and their witnesses.

## Consequences

- Until the card `clientspawn` moves the callers, the flags exist in the existing functions and in the adapter.
  The golden test keeps both equal; after the move its literal table keeps them where they were.
- Reversing the shape of the contract costs little before 0.47, when Claude is its only implementer, and more with
  each adapter after it.
- What would reverse the `client` branch: a second adapter whose choice cannot be told per role, or a repository
  where the record in `construct.json` has to differ between clones.

## Enforced at

L3: `scripts/tests/client/contract.test.ts` compares each role's invocation, as a start and as a resume, with the
argv of the existing code. L1 review for the selection design, which runs nothing until 0.47. The rule that a
client literal lives only in the adapter belongs to the card `clientseal`.
