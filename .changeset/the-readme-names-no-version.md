---
"mikoshi-construct": patch
---

The README names no version, and its opening paragraph says what the tool is today

The front page opened with **v0.3.** while the published package was 0.16.x. Replacing the number
would have been the wrong repair: nothing kept the claim true, so a correct number restarts the
same decay from a later date. The defect is that the README asserts a fact it has no way to hold,
and the fix has to remove the assertion or give it a source.

Between the two shapes — the README naming no version, or the version rendered into it from
`package.json` by a harness step — it names none. Nothing is lost by that: npm prints the version
beside the README on the package page, the documentation site prints it, and `construct doctor`
reports the version that materialized a given repository, which is the number a reader of a
*repository* actually needs. A render script and a check would add a second producer of a fact
three surfaces already publish.

`tests/readme-version.test.ts` holds the property under either shape: every version-shaped claim in
the README must equal the version in `package.json`. A README that names no version passes because
it claims nothing; a rendered one would pass because it claims the right thing. The test also reads
a claim out of a constructed sample and reads the token counts in the cost section as measurements,
so it cannot pass by detecting nothing.

The same paragraph was stale in content. It named the presets and `construct sync` alone, from when
`sync` was the newest thing; there are six commands now, and it said nothing about the two records
that carry what a repository is — `construct.json` for provenance, `construct.model.json` for
knowledge — which is what discovery, `doctor` and `graph` stand on. It now names both and stays a
paragraph.
