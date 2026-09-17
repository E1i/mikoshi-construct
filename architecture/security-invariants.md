# Security invariants

Security is its own review dimension. Each invariant names what enforces it; `review` means the
reviewer is the only check, so weigh those the most. A finding that recurs is an architectural
problem: move the protection to a shared boundary and add a check rather than fixing the symptom
again. Method: [principles.md § Security](principles.md#security).

The baseline rows below are enforced by files this construct materialized. Discovery adds the rows
that are specific to this system — the ones where money, identity or data can be corrupted.

| Invariant | Enforced by |
|-----------|-------------|
| No secret, token or connection string in any file, including gitignored ones; config references `${VAR}` placeholders | `.github/workflows/security.yml` runs gitleaks over the history on every push and pull request (`.gitleaks.toml` keeps the default ruleset live); review |
| Dependencies with known high-severity vulnerabilities are visible | `security.yml` runs `pnpm audit` weekly and on pull requests, reporting only |
<!-- construct:discover:security-invariants -->
| `init` never overwrites a file it did not create: existing files are skipped, `package.json` is merged with existing keys winning, `CLAUDE.md` / `AGENTS.md` / `.gitignore` are edited only inside their `construct:begin … end` block, filled discovery blocks are carried over | `tests/strategies.test.ts`, `tests/init.test.ts` ("never overwrites existing files", "is idempotent", the give-buddy clone case); there is no `--force` flag |
| A template renders completely or not at all: an unknown `{{variable}}` throws instead of leaving a placeholder in a generated file | `render()` in `src/materialize/templates.ts`; `tests/templates.test.ts` |
| The CLI spawns exactly one child process, `pnpm --version`, with fixed arguments and no shell, and executes no code it did not ship | The `spawnPolicy` `no-restricted-syntax` block in `eslint.config.mjs` fails the build on, anywhere under `src/` except `src/detect/package-manager.ts`: a static `import` of `node:child_process`, any dynamic `import()` expression whatever its specifier, a `require` call or `require.*` member access, a static import of `node:module`, and any `createRequire` identifier; `tests/dependency-policy.test.ts` lints one source sample per form through ESLint and asserts the block still carries the antfu base restrictions |
| `init` writes only under the target directory; every target path comes from the package's own `templates/` tree, never from user input | review (`applyPlan` joins `root` with template-derived targets; no path in a template starts with `..`) |
| Templates carry no secret: workflows reference `${{ secrets.* }}` and `CODE_REVIEW_API_KEY` by name only | `.github/workflows/security.yml` runs gitleaks over `templates/**` too; review |
| `cost` reads Claude Code session files under `~/.claude/projects/<this dir>` and aggregates token counts only; no message content is printed or stored | `tests/cost.test.ts`; review |
| A release is a reviewed, versioned event: `npm publish` runs only from `release.yml` / the `release` script with provenance, never from a developer shell against `main` | review; `.github/workflows/release.yml` |
<!-- /construct:discover:security-invariants -->
