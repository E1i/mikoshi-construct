# Card 658 — why `pnpm run quality` is not green in a cloud session

## Environment facts

| Fact | Value |
|------|-------|
| `id -u` | 0 (root) |
| `node -v` | v22.22.0 (`/opt/node22/bin/node`) |
| `pnpm -v` in the repo | 12.4.2 (outside the repo: 10.28.0) |
| `uname -m` | x86_64 |
| `file $(command -v pnpm)` | `/opt/node22/bin/pnpm: symbolic link to /opt/node-tools/node_modules/.bin/pnpm` (-> pnpm 10.28.0, `pnpm.cjs`, a Node script) |
| `.npmrc` | `engine-strict=false` |
| `packageManager` | `pnpm@12.4.2` |
| install | Not corepack (corepack 0.34.0 exists, `COREPACK_ENABLE_AUTO_PIN=0`). pnpm 10.28.0 is a global npm package in `/opt/node-tools`; on seeing `packageManager` it self-installs 12.4.2 into `~/.local/share/pnpm/.tools/pnpm/12.4.2` |
| `pnpm-workspace.yaml` | `shellEmulator: true` |

`pnpm install` -> exit 0.

## Cause 1: nested pnpm, `Exec format error`

Repro (`/tmp/rp`, `packageManager: pnpm@12.4.2`, `shellEmulator: true`, scripts `a: pnpm --version`, `b: pnpm run a`):

- `pnpm run b` -> exit 1, `Error launching 'pnpm': Exec format error (os error 8)`
- `pnpm exec pnpm -v` -> exit 1, `Failed to spawn command "pnpm": Exec format error (os error 8)`
- `npm_config_shell_emulator=false pnpm run b` -> same error, exit 1 (no help).

Cause: pnpm 12 ships `pnpm` as a shebang-less `sh` placeholder that its `install.js` preinstall replaces with the native ELF. Here pnpm 10 installed 12.4.2 into `.tools/` with lifecycle scripts blocked, so the placeholder stayed (`file`: "ASCII text"). `.tools/pnpm/12.4.2/bin` is first on PATH inside scripts. The shell emulator execve()s `pnpm` directly with no shell; a script without a shebang gives ENOEXEC. The native binary is on disk (`node_modules/@pnpm/exe.linux-x64/pnpm`, ELF) but is not linked.

Remedies, both proven:

- `PATH=<.tools/pnpm/12.4.2/node_modules/@pnpm/exe.linux-x64>:$PATH pnpm run b` -> exit 0, prints 12.4.2.
- `node <.tools/pnpm/12.4.2/node_modules/pnpm>/install.js` (run there) -> exit 0, `pnpm` becomes an ELF; then `pnpm run b` -> exit 0.

Environment need: run pnpm 12's install script once (or install pnpm 12.4.2 globally with scripts allowed, so the native binary is linked) before the gate.

## Cause 2: root defeats chmod 0444

Test: `scripts/tests/ghosts/cleanup.e2e.test.ts`, cases `l2` and `s2` (`chmodSync(..., 0o444)`, then expects EACCES on the append).

Repro: `echo a>/tmp/ro.txt; chmod 0444 /tmp/ro.txt; echo b >> /tmp/ro.txt` as uid 0 -> exit 0 (CAP_DAC_OVERRIDE). The vitest run: `Tests 2 failed | 3919 passed | 15 skipped`, both at `expect(existsSync(.../runs.jsonl)).toBe(true)` (`expected false to be true`): the write succeeded, so the tree was removed instead of kept.

Remedy, proven: drop the capability, not the uid:
`setpriv --bounding-set=-dac_override,-dac_read_search --inh-caps=-all sh -c 'echo b >> /tmp/ro.txt'` -> exit 2, `Permission denied`.
`setpriv ... pnpm exec vitest run scripts/tests/ghosts/cleanup.e2e.test.ts` -> exit 0, 39 passed.
Running as a non-root user would do the same (not tried: needs a user with access to the checkout).

## Other red steps

Each step of `quality` run separately (before the cause-1 fix, run from the shell, so no nested pnpm):

| Step | Exit |
|------|------|
| composition:check | 0 |
| model:check | 0 |
| privacy:check | 0 |
| lint | 0 |
| typecheck | 0 |
| test | 1 (only l2, s2 — cause 2) |
| docs:build | 0 |
| docs:pending | 0 |
| docs:anchors | 0 |

Nothing else is red. `pnpm run quality` itself chains steps with `pnpm ...`, which is exactly the nested call of cause 1; I did not capture its pre-fix failure, only the minimal repro above.

## What the environment needs for a green gate

1. pnpm 12.4.2's native binary linked (run its `install.js`, or put `@pnpm/exe.linux-x64` first on PATH).
2. The gate run without CAP_DAC_OVERRIDE (or as non-root).

Proof, both together: `setpriv --bounding-set=-dac_override,-dac_read_search --inh-caps=-all pnpm run quality` -> exit 0, all nine steps, after the install.js relink.
