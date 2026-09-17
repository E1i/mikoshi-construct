# Decisions

One file per decision that shapes what this tool is allowed to claim. A decision lands here when
reversing it would cost more than making it did, or when a later reader would otherwise re-open it
from scratch.

Each record names how it is enforced and at what level: L0 text only, L1 review, L2 a local hook,
L3 CI, L4 CI that blocks merge. A decision enforced only by review says so; that is the honest
answer, not a gap to hide.

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
