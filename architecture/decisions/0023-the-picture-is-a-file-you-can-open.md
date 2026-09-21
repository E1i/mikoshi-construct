# 0023 — The picture is one file you can open, and what would count as evidence anyone did

Status: accepted · 2026-09-21

## Context

[0017](0017-v5-adds-no-new-way-of-knowing.md) makes the interaction step conditional: clicking,
filtering, drill-down and history "must earn their place on top of a model people already read". The
picture step shipped Mermaid on stdout, which is the right machine-readable artifact and is not a
picture a person can open — it needs a viewer that is somewhere else. So the condition 0017 places on
the next step could not be met or failed; there was nothing to be used or not used.

## Decision

**`construct graph --out <path>` writes one self-contained HTML file.** Inline SVG, inline styles,
nothing fetched when it is opened — no CDN, no script, no network from a `file://` URL or anywhere
else. A few kilobytes.

**stdout is untouched and stays the default.** The Mermaid is written exactly as before, byte for
byte, and the file is written afterwards. `--out` adds; it replaces nothing.

### The renderer is ours, and the reason is a measurement

Inlining Mermaid was the obvious route and was rejected on numbers taken before any code was
written. The published package is **0.28 MB** across 98 files. Mermaid's minified bundle alone is
**3.4 MB**, so the package would grow roughly thirteenfold, every rendered file would weigh 3.4 MB,
and a tool whose security invariant is that it *executes no code it did not ship* would begin
shipping 3.4 MB of third-party JavaScript and writing it into files it creates.

Paying a thirteenfold increase in what every user downloads, to deliver a picture no person has yet
read, inverts the order 0017 sets. The costs are also asymmetric in how they reverse: the size of a
published package reverses badly, while our own extra code is deleted in one commit.

### One structure, two serializers

A second renderer reading the model directly would be a second reader of one list — the defect class
this repository has now fixed three times in a week, in the template against the facts, in the
enforcement levels spelled out in two files, and in the harness steps. So the split is one level
earlier than the output:

`renderModelGraph` becomes `graphOfModel` producing a structure of nodes and edges, and
`mermaidFromGraph` serializing it. `svgFromGraph` serializes the same structure. The two may lay the
picture out differently; they may not disagree about what is in it. A test asserts that both name
every node and every edge of the structure, and the Mermaid is pinned against the rendering as it
was before the split.

## What would count as evidence the picture is used

Recorded here as a prediction, before the thing that would produce it exists, so that the interaction
step cannot later be justified by "it seemed useful".

**The one observable signal: a request for the picture from someone who did not build it, arriving
unprompted.** It needs no instrumentation, it arrives in the channel or in an issue, and it is
recorded as a dated entry in [observations.md](../observations.md) when it happens.

**The other candidates cannot be measured here, and that is a statement about this tool rather than a
deferral.** Whether the file is opened at all, whether it is opened twice on the same model, and
whether a question about a repository was answered from it rather than from `doctor --json` are all
invisible to a CLI that emits no telemetry, keeps no usage record, and by
[0001](0001-findings-corpus-outside-the-cli.md) does not even carry a hand-transcribed findings
corpus. Measuring them would mean adding the thing this package has already refused, which is a
larger decision than the picture.

**An absence of requests is not evidence against the picture either.** It is an absence. If none
arrives, the interaction step stays unbuilt on that absence rather than on a measurement, and this
record is what keeps the two apart.

## Colour carries state, and one sentence says so

On a default-preset tree an L0 claim nobody is obliged to read and an L3 claim that fails the build
are **the same green** — which is true of this repository's own picture, where
`vulnerable-dependencies-are-visible` is L0 and `no-committed-secret` is L3. Each claim's level is
written inside it, but colour is read first and text second, so the page implied that green means
*fine* when it means *the facts named under it hold*. That is [rule 1](../epistemic-rules.md) in the
strongest perceptual channel, claim and enforcement and strength collapsed into one mark, and
[rule 2](../epistemic-rules.md) turned around: saying nothing about strength reads as strength being
absent.

**The correction is one sentence rendered with the legend**, because the legend is what explains the
colour. No new channel, no new colour, no new element, no layout change.

**The picture does not show enforcement strength and is not intended to.** The sentence prevents a
wrong reading; it does not supply a right one. A reader who wants to compare strength reads the level
inside each claim, or `doctor`, which reports it per check.

**A channel of its own for strength was costed and set aside, not overlooked.** Encoding the level as
a second visual channel — border weight, a bar, a glyph — was the alternative. It is deferred on the
same condition this record already sets for interaction: it is built when there is a recorded reading
of the picture, and not before. Adding a channel for a distinction nobody has yet been observed
needing would be the same inversion of 0017's order as taking a renderer dependency before anyone had
read the picture at all.

## What this delivery is not

Rendering a model is not reading it. A file that exists is not a file anyone opened, and a picture
that draws every state correctly says nothing about whether the states are the right ones to draw.
The command's output is a projection of the model ([0016](0016-the-model-is-the-source.md)) and adds
no claim, no inference and no new way of knowing — which is what makes it the kind of step 0017
allows here.

## Consequences

The package gains a renderer of its own: a layout, an elision rule for long labels, a parallel-edge
spread and a label separation pass that makes two labels closer than a line unconstructible. All of it is ours, testable, and deletable. The layout is deliberately plain —
two columns, no crossing minimisation — because a better layout is a change to one function rather
than a reason to take a dependency.

Where a reading draws nothing, no file is written, so `--out` on a repository with no model behaves
exactly as `graph` does today.

## Enforced by

`tests/graph-page.test.ts` (L3): the Mermaid serialized from the structure equals a fixture captured
from the renderer as it stood before the split; both serializers name every node and every edge of
the same structure; a model exercising all three derived states renders each one as a shape class and
in the entry's own words, not only in the legend; the page carries no script, no remote reference and
no namespace-external URL; a needle carrying a quote or a tag is escaped in both; the sentence about
colour renders after the legend, taken from the renderer's constant so a reword moves the test with
it, beside an assertion that this repository's own model really does carry more than one enforcement
level under a single colour; and nothing is written where nothing is drawn.
