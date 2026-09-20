# Rejected architect payloads

Ten `StructuredOutput` calls that the runtime refused, recorded from two architect entries in one
`/implement` run against a private repository this construct had materialized. Both entries ended in
the Design phase and returned nothing at all: two tasks designed, no design, no code.

They are kept because they are the only specimen of this failure taken from a tree nobody built to
demonstrate it. The run's journals live under `~/.claude/projects/` and are deleted with the first
cleanup of that directory, so nothing here can be harvested a second time.

## What each record holds

| Field | Meaning |
|-------|---------|
| `run`, `agent`, `attempt`, `timestamp` | Where in the run the call sits, and in which order |
| `effort`, `stopReason`, `outputTokens` | The completion metadata the journal recorded for that request |
| `outcome` | `unparsable` — the runtime could not read the input as JSON; `empty` — it read an object with no properties |
| `reportedBytes` | The payload size the runtime named in its own error, for an `unparsable` call |
| `journaledChars` | How many characters of the payload the journal kept, before the replacements below |
| `validatorError` | The tool result verbatim |
| `payload` | The payload as far as the journal kept it |

## What is evidence here, and what is not

`reportedBytes`, `validatorError`, `outcome` and the attempt order are what the runtime reported.
They are the record.

`payload` is **not** the payload. The journal keeps the first 2048 characters of a tool input and
drops the rest, while the runtime reported sizes from 3436 to 10 293 bytes. Every `unparsable`
record therefore stores a prefix that is itself cut off, and running `JSON.parse` on it fails
because of that cut, not because of the defect. **The bytes at which these payloads actually became
invalid are not here and cannot be recovered.** A test that proves one of these prefixes fails to
parse has proved something about the logger. The stored text is also a few characters shorter than
`journaledChars` wherever a replacement below was shorter than what it replaced.

`design-a-attempt-5` records `stopReason` and `outputTokens` as `null`: the journal holds no
completion metadata for that request. That is the absence itself, not a value to fill in.

## The shape of the failure, as observed

Every recorded completion stopped with `tool_use`, never `max_tokens` — the model considered each
call finished. The payloads were nonetheless unreadable, and the runtime's own error names the
causes it knows: unescaped backslashes, unescaped control characters, or truncated output. All ten
calls ran at `xhigh`, the effort the ladder gives Design.

Both agents shortened their answer on each retry — 4564 → 4030 → 3436 bytes, and 10 293 → 9293 →
7396 — and were rejected every time, then degenerated into calling the tool with no arguments at
all, which is what the `empty` records are. So size alone does not separate a call that works from
one that does not: 3436 bytes failed here.

Read that before treating a bound on the schema as the fix. A bound is a limit the validator
applies after the input parses; seven of these ten never parsed, and no length the schema declares can
change that. A bound may still be worth having for what it tells the model to aim at, which is an
argument about the prompt, not about validation.

## Where they break

`tests/architect-payload-shape.test.ts` reads every `unparsable` record and asserts what the kept
window can still establish. In all seven: the payload begins at `{` with no fence and no prose around
it; there is not one raw control character anywhere in the window; and `decision` — the long
free-prose field — closes cleanly, between 1255 and 1809 characters, correctly escaped. The window
then runs out inside `contractChanges`, the second field, in all seven.

So the field the obvious fix would bound is the one field every failure got right, and between 1388
and 8245 bytes of each payload — the rest of `contractChanges` and the four fields after it — is
where the malformation has to be. That part is gone and cannot be recovered from this record.

What that rules out, it rules out for the visible window only: a fence, prose around the object, an
unescaped quote before the cut, and a raw newline inside `decision`. Between a raw newline in a later
field and an answer that stopped mid-object, this record cannot choose. Deciding that needs a new
observation that keeps the whole payload, which is the first thing any measurement of the rate should
be built to do — the journal that recorded these threw away the only part that mattered.

## Names

The vocabulary of the private project's product surface has been replaced: the geographic list, the
money bands and the phrase naming what the geographic list described. The replacements keep the
arity and the shape of each list, because what these records exercise is the size and structure of
the answer, not its subject. Nothing here names a real project, a real repository, a real account or
anyone's counterparty.

The task briefs the two agents were given are deliberately not stored. They named a private
repository and the accounts that own it.

Nothing here should ever be edited toward "more realism", and nothing here should be regenerated —
the source is gone.
