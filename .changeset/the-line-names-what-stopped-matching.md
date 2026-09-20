---
"mikoshi-construct": patch
---

The you-are-here line now names the fact that stopped matching, instead of stopping at the claim and
the stage.

It is the one line a reader sees if they see one line, and it is the line most often read apart from
everything around it — torn into a CI log, a grep result, a forwarded snippet. A line that pointed at
the verdict above it would say nothing in exactly the places it actually gets read, so it says the
fact itself. The verdict and the line are two projections of one value rendered in one run; they
cannot drift, and a second store is what the no-duplication rule forbids.

Length is bounded by form rather than by truncation: a stage with several failing facts names one and
counts the rest — `package.json, and 2 more` — with the full list staying in the verdict. A stage that
could not be read names no fact, because nothing was established about it. The facts are a required
argument of the call that renders the stopped line, so a line claiming a stop without naming one
cannot be written.

The three situations with no path — no model, a model carrying no claim, a model whose every chain
holds — read exactly as before.

A stage that could not be read names the path it could not read, and still blames nothing. Naming
what was unreadable is information; naming a fact as failing when none did would be the substitution
this release exists to remove, and the two are easy to confuse. Without the path the line said that
*something* could not be read — true, and useless to anyone reading it out of a CI log, which is the
one thing this line is for.

Where several facts stopped matching the count says what it is counting — "and 2 more facts" rather
than "and 2 more" — because the line is read where nothing around it explains the number.
