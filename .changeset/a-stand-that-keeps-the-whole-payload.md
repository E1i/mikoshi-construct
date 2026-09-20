---
"mikoshi-construct": patch
---

A capture harness for the design step, built so that it cannot repeat the defect that cost the last
investigation its answer. `pnpm bench:architect` runs the architect alone — one brief, one
invocation, no implementer and no harness agent — and records, for every call: the payload whole with
no cap, the byte offset at which parsing fails, the character sitting at that offset and its
surroundings, every control character anywhere in the payload with its offset and name, the reason
generation stopped, and the output token count.

It streams with `eager_input_streaming` and accumulates the raw fragments itself rather than reading
the SDK's parsed input, because both of those layers would repair or silently truncate exactly the
bytes in question: the server validates a buffered tool parameter before emitting it, and the SDK
accumulates fragments with a tolerant parser that returns a shortened object instead of raising. The
harness holds what the model actually emitted, and the whole stream consumption is wrapped so that a
payload survives even when the SDK rejects it.

The classifier separates the two things the old record could not tell apart: an escaped `\n` inside a
value, which is legal and parses, and a raw newline, which is not and does not. It names each refusal
as `control-character`, `ended-early`, `not-an-object` or `unnamed`, and a test exercises every one of
those names against a handwritten payload, including the pair that is the whole open question.

The corpus is the nine real briefs from this repository's own ladder runs, frozen alongside the
outcomes they produced. Using our own briefs rather than another project's keeps the measurement free
of someone else's material and costs nothing, because the defect is in the shape of the output and not
in the subject of the task. The schema and the instructions come from the ladder script and the
architect agent file rather than being restated, so the harness measures the contract that ships.

Its first run is diagnostic, not acceptance — the script says so before it does anything, and says
that no result from it may be reported as a rate. A rate is measured afterwards, against whatever
cause the diagnosis names. The script also refuses to spend money without `--yes`, and nothing about
it is wired into `pnpm run quality`.
