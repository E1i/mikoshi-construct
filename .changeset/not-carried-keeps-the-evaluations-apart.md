---
"mikoshi-construct": patch
---

An absent claim distinguishes evidence that fails from evidence that could not be read

The first cut of the not-carried block tested `evaluation !== 'holds'`, which merged two different
states — *this is false here* and *we could not look* — and left the choice between them to the
declaration order of `supportedBy`.

Each absent claim now carries its reading: a fact that does not hold, a fact that could not be read,
or every fact holding. Where both a failing and an unreadable fact are present the failing one is
reported, because it is the one a reader can act on, and that preference is stated rather than
inherited from list order.
