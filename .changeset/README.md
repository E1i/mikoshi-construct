# Changesets

Every pull request that changes what users get ships a changeset: `pnpm changeset`, pick `patch` or
`minor` (this is 0.x: a template change that alters a generated project's behaviour — a lint rule, a
harness script, an agent instruction — is `minor`; a text fix is `patch`), and start the summary with
`cli:` or `templates:` so the changelog reads as two streams. On merge to `main`, the release workflow
opens a "Version Packages" pull request; merging that publishes to npm with provenance.
