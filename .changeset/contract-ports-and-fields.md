---
---

`contract/factory.json` now describes the seam between `src/` and `scripts/`. `ports.boundary` lists every `src` export a non-test `scripts/` file imports, with its signature, and `PORTS_VERSION` goes to 3. The list is generated, never written by hand. Exports used only inside `src` or only inside `scripts` are not listed. `card.fields` now also names the labels the card grammar reads from a card body (`tools:`, `corrected:`, `whole:`, `import:`, `ladder:`, `witness layer:` and the rest) and the intake draft fields (`draft.*`, `draft.plan.*`). The event catalogue gains `supervisor.restart_missed` with its payload (`limit_ms`, `sha`, `waited_ms`).

Every layer of the check catalog must have at least one test. A test under `scripts/tests/<x>/` belongs to the layer of `scripts/<x>/`, so `scripts/tests/ci/**` now belongs to layer `ci`. A card whose change reaches a layer with no test no longer falls back to the full run: `cardRunsOf` throws `LayerWithoutTests` and the pre-push run fails. `scripts/tests/ci/layer-has-tests.test.ts` makes CI fail as soon as any layer of the catalog has no test.
