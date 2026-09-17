---
"mikoshi-construct": minor
---

Discovery fills the markers in `AGENTS.md` and the invariants table, and once filled nothing distinguished what the tool wrote from what the repository's owner stands behind. `construct.json` now records it: `discovery.baseSha`, `discovery.filledAt`, and per marker the file it lives in, who authored it and the sha256 of the body discovery wrote. The marker itself stays a document a person reads — provenance in the prose would spoil the document and would put the record in the one place most likely to be edited.

Authorship by the owner is never declared, only derived: a marker whose body no longer matches its recorded sha reads as theirs, with no command to run and nothing written back. Editing it by hand is the only evidence needed. `doctor` names the markers that still read back, word for word, what the tool wrote — the places where the repository is quoting the construct at itself — and reports it without making it a gate or changing an exit code.

`construct.json` also carries an integer `manifestVersion`, separate from `construct`, which is the CLI version; conflating a schema version with a product version is what makes a later migration undecidable. Manifests written by 0.1.x are normalised on read by a pure upgrade, so a repository initialised before this change gets a report instead of a crash. Their markers read as `unknown`, never as the construct's: a legacy manifest carries no provenance, and claiming otherwise would have this feature produce exactly the lie it exists to prevent.
