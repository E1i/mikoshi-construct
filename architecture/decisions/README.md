# Decisions

One file per decision that shapes what this tool is allowed to claim. A decision lands here when
reversing it would cost more than making it did, or when a later reader would otherwise re-open it
from scratch.

Occurrences of something a record already describes belong in
[observations.md](../observations.md), not in the record. A decision is stable and an observation
accumulates, and a log kept inside a decision is eventually tidied into its text — which gives it
scope it never had.

Each record names how it is enforced and at what level: L0 text only, L1 review, L2 a local hook,
L3 CI, L4 CI that blocks merge. A decision enforced only by review says so; that is the honest
answer, not a gap to hide.

Every level above L0 presumes a mechanism that **can report a failure**. L3 and L4 differ over
whether a failure blocks a merge; L0 and L3 differ over whether a failure can be raised at all. A
check that is green whether or not the invariant holds — a CI job that always succeeds, a script
whose exit code is discarded — reports nothing and is L0, however much machinery stands behind it.

| # | Decision | Enforced at |
|---|---|---|
| [0001](0001-findings-corpus-outside-the-cli.md) | The findings corpus lives outside the CLI | L1 review |
| [0002](0002-provenance-in-the-manifest.md) | Discovery provenance is recorded in the manifest | L3 doctor |
| [0003](0003-run-ledger-stops-at-l0.md) | The run ledger stops at L0, and says so | L0, reconciled |
| [0004](0004-domain-allowlist-in-templates.md) | Template hygiene uses an allowlist, not a denylist | L4 CI |
| [0005](0005-one-output-contract-per-agent.md) | One output contract per agent, declared by the schema | L4 runtime |
| [0006](0006-the-init-manifest-is-frozen.md) | What init wrote in construct.json is frozen | L3 replay test |
| [0007](0007-doctor-executes-nothing.md) | `doctor` executes nothing from the repository it audits, and never claims L4 | L4 CI |
| [0008](0008-a-retry-buys-a-new-exploration.md) | A retry buys a new exploration, not a new attempt | L3 test, L1 review |
| [0009](0009-the-manifest-carries-its-own-schema-version.md) | The manifest carries its own schema version, and a manifest without provenance is unknown | L3 test |
| [0010](0010-sync-classifies-what-the-construct-owns.md) | Sync classifies what the construct owns, and favours keep | L3 tests, L1 review |
| [0011](0011-design-is-part-of-the-run.md) | Design is part of the run, and a run reports the class it performed | L3 tests, L1 review |
| [0012](0012-sync-writes-what-it-compared.md) | Sync writes exactly what it compared, and only where ownership is provable | L3 tests |
| [0013](0013-a-second-init-adds-to-the-record.md) | A second init adds to the record and crosses out nothing | L3 tests |
| [0014](0014-a-check-answers-only-about-what-it-was-shown.md) | A check answers only about the set it was shown | L3 test, L1 review |
| [0015](0015-interpretation-stays-with-the-agent.md) | Interpretation stays with the agent; the CLI records facts and checks them | L3 test |
| [0016](0016-the-model-is-the-source.md) | The model is the source; doctor, the graph and reports are projections | L1 review, L3 tests |
| [0017](0017-v5-adds-no-new-way-of-knowing.md) | v5 adds no new way of knowing | L1 review |
| [0018](0018-evidence-clean-scopes-to-the-evidence.md) | A hypothesis records whether its evidence was committed, not whether the tree was clean | L3 tests |
| [0019](0019-a-specimen-is-described-by-structure.md) | A specimen is described by structure, never by address | L1 review |
| [0020](0020-a-claim-is-written-only-where-its-evidence-holds.md) | A construct-authored claim is written only where its evidence holds at birth | L3 test |
| [0021](0021-a-record-of-the-past-is-not-edited.md) | A record of what a past version said is not edited to match what is true now | L1 review |
| [0022](0022-a-manifest-ahead-of-the-reader-is-a-state.md) | A manifest from a later build is a state this binary reports, not one it normalises | L3 test |
| [0023](0023-the-picture-is-a-file-you-can-open.md) | The picture is one file you can open, and what would count as evidence anyone did | L3 test |
| [0024](0024-an-absent-claim-is-derived-not-recorded.md) | An absent claim is derived on read, never recorded | L3 test |
| [0025](0025-a-premise-that-can-be-a-fact-is-not-left-as-prose.md) | A premise expressible as facts is written as a hypothesis; prose is understood to age | L1 review |
| [0026](0026-which-packages-exist-is-derived-what-they-may-import-is-recorded.md) | Which packages exist is derived; what each package may import is recorded | L3 test |
| [0027](0027-an-acceptance-is-red-before-the-implementation-exists.md) | An acceptance is red before the implementation exists | L1 review |
| [0028](0028-a-model-ahead-of-the-reader-is-a-state.md) | A model from a later build is a state this binary names | L3 test |
| [0029](0029-an-acceptance-is-red-under-a-named-wrong-implementation.md) | An acceptance criterion is shown red under a named plausible wrong implementation | L1 review |
| [0030](0030-public-contract.md) | The public contract is a recorded surface, and changing it requires the bump it implies (proposed) | L1 review; L3 and L4 with the code |
| [0031](0031-the-cli-owns-the-mutation-the-runner-owns-execution.md) | The CLI owns a mutation from edit to verdict; running the repository's tests stays with the runner | lint (execution half); L1 review until the `mutate` tests land |
