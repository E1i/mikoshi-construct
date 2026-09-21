---
"mikoshi-construct": patch
---

Records describe a specimen by structure, never by address

`architecture/decisions/0019` promotes a rule that had been living as a clause inside one
observation, where it governed nothing: a repository used as a specimen is described by its layout,
role, package manager, relation to this tool and the artifacts the finding turns on — never by name,
npm scope, owner, URL, identifying commit or problem domain. Where the address sits inside quoted tool
output, the quotation is either dropped for a description or marked redacted, never silently edited.

Nine sites that named specimens by address were corrected and one stale citation to a test that does
not exist was fixed. Frozen fixtures under `tests/fixtures/` are exempt by the record: they are what a
past version wrote, not what this repository is still authoring.

The record also states the cost rather than softening it. The three runs those entries describe are no
longer reproducible: their addresses are not held anywhere this repository can cite, and 0001's
findings corpus is a decision rather than a repository that exists. Addresses already published remain
in git history and in pull request bodies; the rule governs records written from now on.
