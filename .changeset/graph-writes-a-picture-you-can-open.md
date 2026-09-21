---
"mikoshi-construct": minor
---

construct graph --out writes a picture you can open

`graph` put Mermaid on stdout, which is the right machine-readable artifact and is not something a
person can open: it needs a viewer that lives somewhere else. `--out <path>` now also writes one
self-contained HTML file — inline SVG, inline styles, a few kilobytes, and **nothing fetched when you
open it**: no CDN, no script, no network from a `file://` URL or anywhere else.

stdout is untouched and stays the default. The Mermaid comes out byte for byte as before, pinned by a
fixture captured from the renderer as it stood before this change.

The renderer is ours rather than an inlined Mermaid, on numbers taken before any code was written:
the published package is 0.28 MB and Mermaid's minified bundle alone is 3.4 MB, so inlining it would
grow the package roughly thirteenfold, weigh every rendered file at 3.4 MB, and make a tool whose
invariant is that it executes no code it did not ship start shipping 3.4 MB of third-party
JavaScript. Paying that before any person has read the picture inverts the order decision 0017 sets.

Both outputs are serialized from one structure, so they can differ in layout and cannot differ about
what is in the picture — a test holds them to each other. Decision 0023 records that, and records
before the fact what would count as evidence the picture is used: one observable signal, and a plain
statement that the others cannot be measured by a CLI that emits no telemetry.
