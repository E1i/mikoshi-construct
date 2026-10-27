---
description: Name the parts of an attached repository and write them into its Engram outside the repository, touching no file inside it.
argument-hint: [area to (re)discover, or empty for everything]
---

You are running discovery in a repository the construct attached to and does not own. Read the code, name
its parts, and write the result into the Engram under the user's home directory. Write nothing you did not
verify by reading code.

Scope: `$ARGUMENTS` (empty means everything).

1. Run `construct atlas` (or `npx mikoshi-construct atlas`) from the repository root. It prints nothing
   you need except the page it wrote; the Engram is `~/.construct/engram/<directory>-<hash>/construct.model.json`,
   where `<hash>` is the first twelve hex digits of the sha256 of the repository's real path.
2. Read the Engram's `mechanics.contours`, the parts the repository's own configuration separates, and
   `mechanics.components`, every tracked file. Inside each contour, group its files into components, each
   a part a reader would name, with an `id`, the `contour` it lies in, a `name` and a one-line `purpose`.
   A file belongs to at most one component; a file you cannot place stays out.
3. Write the components under the top-level `interpretation` key of that same Engram file, beside
   `mechanics` and never inside it, with `"authoredBy": "discovery"`:

   ```json
   {
     "interpretation": {
       "authoredBy": "discovery",
       "components": [
         { "id": "billing-api", "contour": "apps/billing", "name": "Billing API", "purpose": "Takes a charge request and records the charge", "files": ["apps/billing/src/routes.ts"] }
       ]
     }
   }
   ```

4. Run `construct atlas` again and report the page it names.

Write only that one Engram file. Never write inside the repository: not `AGENTS.md`, not `CLAUDE.md`, not
`construct.json`, not `construct.model.json`, not a marker, not a composition model. The only paths the
construct made here are listed in `.git/info/exclude`; leave everything else as it is. When a high-effort
list is wanted, `/implement` reads it from `.construct/high-effort-areas.md`, which you write only when the
user asks. Do not commit.
