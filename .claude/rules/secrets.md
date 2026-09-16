# Secrets and configuration

- Never write an API key, token or connection secret into a config file — including gitignored or
  otherwise local-only files. Local config still gets backed up, synced and read by other tools.
- Config files reference secrets through placeholders that resolve at runtime from the process
  environment (`${VAR}`, `${VAR:-default}`); the real values live only in the shell environment.
- When a plan depends on a specific config syntax — variable expansion, default fallbacks, a particular
  frontmatter key — verify against the tool's official documentation before building on it.
