# Contributing

The most useful contribution is a preset for a stack the construct does not cover yet, or a fix to
a template that broke a generated project. Both follow the same loop.

## The loop

```bash
pnpm install
pnpm dev init --yes --preset node-backend --dir /tmp/demo   # run the CLI from source
cd /tmp/demo && pnpm install && pnpm run quality              # the acceptance every preset must pass
```

`pnpm run quality` in this repository is the gate for your change; the acceptance above, for every
preset you touched, is the gate for the templates. CI runs both — the acceptance on Node 22 and 24
and once under pnpm's `minimumReleaseAge` policy.

Read [CLAUDE.md](CLAUDE.md) before touching `templates/`: it lists the conventions that are easy to
get wrong — `_` for dotfiles, `.eta` and `.existing.eta`, how groups layer, why `no-restricted-syntax`
blocks are cumulative, and where a version bump has to land.

This repository runs on its own construct. `/plan` and `/implement` in Claude Code work here; so does
`construct doctor`.

## Adding a preset

1. `templates/presets/<id>/baseline/` — what every repository gets: lint policy, `package.json`
   partial, tsconfig. `templates/presets/<id>/sample/` — example code, written only into an empty
   directory. Anything shared with another preset goes to `templates/stacks/`.
2. Register it in `src/presets/index.ts` with its groups and variables.
3. Ship the generated artifacts pre-generated (contract types, rendered composition docs) so the
   harness is green at first run; regenerate them in a scratch project and copy back.
4. Add the preset to the acceptance matrix in `.github/workflows/ci.yml` and to the README table.
5. `pnpm changeset` — `minor`, summary starting with `templates:`.

## Version ranges

Point every range in a template at the previous release, not the latest. Users run pnpm with
`minimumReleaseAge`; a range that only matches today's publish fails their first install. The
places a bump touches are listed in CLAUDE.md.

## Reporting a discovery that went wrong

If `/construct-discover` filled a marker with something false, open a "Discovery report" issue with
the marker name, what it wrote and what the code actually says. The protocol is a markdown file
(`templates/ai/shared/_claude/commands/construct-discover.md`); most fixes are one sentence in it.
