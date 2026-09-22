---
"mikoshi-construct": patch
---

Discovery provenance reports every state it computes, and the three causes of "unknown" become three states

`doctor` derived four things about a discovery marker and printed one. `markerAuthorship` answered
`unknown` for three different causes — the marker was never construct-authored, no sha was ever
recorded, and the body could not be read — and the report then kept only the markers still reading
back what discovery wrote and returned early when that list was empty. So `owner`, the one state the
sha exists to surface, was computed on every run and never printed, and a marker whose provenance was
never recorded was indistinguishable from one the owner had rewritten.

Measured on this repository before anything changed: nine of ten markers recorded as `unknown` with no
sha, one recorded as construct-authored whose body no longer hashes to its recorded sha. `doctor`
printed no provenance section at all.

**The incoherent record is now unconstructable rather than handled.** `MarkerProvenance` is a union of
the two combinations that can occur — `construct` with the sha of the body that run wrote, or
`unknown` with `null` — so `construct` with no sha cannot be expressed. `upgradeManifest` is the one
door such a record can arrive through, and it reads it back as `unknown` with `null`. That removes one
of the three causes at the type level and leaves two real states, which is why `authorship` has four
members and no flag:

| reading | what it means |
|---|---|
| `construct` | recorded, and the body still hashes to the recorded sha |
| `owner` | recorded, and the body no longer matches: edited since, and read as the owner's |
| `unrecorded` | nothing was recorded, so there is nothing to compare a body against |
| `unreadable` | recorded, and the body could not be read here |

The report renders each of them from one table keyed by the reading, so a state added later has
nowhere to be silently dropped, and the section is omitted only when there is no marker at all. On the
repository above it now names the edited marker as the owner's and says that nine carry no recorded
provenance.

**`authorship` in `doctor --json` no longer emits `unknown`**; it emits `unrecorded` or `unreadable`,
whichever the reading was. Nothing else about the output changes, and provenance still never changes
the exit code.

The nine markers are left without shas: recording them is a separate change, and doing it here would
have removed the state this was measured against.
