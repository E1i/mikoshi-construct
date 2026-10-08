import type { BuildResult } from '../../ghosts/hash.js'
import type { Shell } from '../../ghosts/preflight-trees.js'
import type { PreflightEnv } from '../../ghosts/preflight.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { approvalLine, checkAcceptanceBuild } from '../../ghosts/hash.js'
import { realShell } from '../../ghosts/preflight-trees.js'
import { runPreflight } from '../../ghosts/preflight.js'

const NOW = new Date(2026, 9, 5, 12)
const APPROVER = 'Approver One'
const NONE_SKETCH = 'Sketch: none — independent implementation is the witness'
const OWNER_MERGES_TEXT = [
  '| kind | paths (globs) | what it covers | example |',
  '|---|---|---|---|',
  '| own-instructions | `.claude/**`, `scripts/shift/merge.ts` | instructions | — |',
  '| ghosts | `scripts/ghosts/hash.ts` | the launcher | — |',
  '',
  '| plain | what it does |',
  '|---|---|',
  '| `scripts/ghosts/status.ts` | status |',
  '',
].join('\n')
const BASE_FILES: Record<string, string> = {
  'README.md': 'base\n',
  'architecture/owner-merges.md': OWNER_MERGES_TEXT,
  'scripts/ghosts/hash.ts': 'export {}\n',
  'scripts/ghosts/status.ts': 'export {}\n',
  'scripts/shift/parking.ts': 'export const pick = 1\n',
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'ghosts-preflight-test-'))
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function writeFiles(repo: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    writeFileSync(path.join(repo, file), content)
  }
}

function world(files: Record<string, string> = BASE_FILES): { repo: string, base: string } {
  const root = scratch()
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFiles(repo, files)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'fetch', '-q', 'origin', 'main')
  return { repo, base: git(repo, 'rev-parse', 'origin/main') }
}

function sketchOn(repo: string, files: Record<string, string>): string {
  git(repo, 'checkout', '-q', '-b', 'sketch/t', 'origin/main')
  writeFiles(repo, files)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'sketch')
  const sha = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'checkout', '-q', 'main')
  return sha
}

interface Brief { sketch?: string, design?: string, acceptance?: string, invariants?: string, immutable?: string }

function briefText(parts: Brief): string {
  return [
    '/implement Make the thing.',
    parts.sketch ?? NONE_SKETCH,
    '',
    `Design: ${parts.design ?? 'Write added.txt.'}`,
    '',
    `Acceptance: the file exists — witness: \`${parts.acceptance ?? 'test -e added.txt'}\`.`,
    '',
    ...parts.invariants === undefined ? [] : [`Invariants: the readme is kept — witness: \`${parts.invariants}\`.`, ''],
    ...parts.immutable === undefined ? [] : [`Immutable: \`${parts.immutable}\`.`, ''],
  ].join('\n')
}

function briefFile(text: string, witnesses: Record<string, string> = {}): string {
  const file = path.join(scratch(), 'brief-t.md')
  writeFileSync(file, `# head\n\n---\n\n${text}`)
  writeFiles(`${file.replace(/\.md$/, '')}.witnesses`, witnesses)
  return file
}

function buildWithoutSketchCheck(implementTextPath: string): BuildResult {
  const text = readFileSync(implementTextPath, 'utf8').replace(/^Sketch: .*$/m, NONE_SKETCH)
  const copy = path.join(scratch(), 'implement.md')
  writeFileSync(copy, text)
  return checkAcceptanceBuild(copy)
}

interface Run { line: string | null, error: string | null, log: string[], pnpmCalls: string[] }

function hashIn(repo: string, text: string, pnpmStatus: Record<string, number> = {}, witnesses: Record<string, string> = {}): Run {
  const log: string[] = []
  const pnpmCalls: string[] = []
  const shell: Shell = (command, cwd) => {
    if (!command.startsWith('pnpm'))
      return realShell(command, cwd)
    pnpmCalls.push(command)
    const status = Object.entries(pnpmStatus).find(([prefix]) => command.startsWith(prefix))?.[1] ?? 0
    return { status, output: `fake ${command}` }
  }
  let tick = 0
  const env: PreflightEnv = { repo, shell, log: line => log.push(line), clock: () => (tick += 100) }
  try {
    const line = approvalLine(briefFile(text, witnesses), NOW, APPROVER, buildWithoutSketchCheck, input => runPreflight(input, env))
    return { line, error: null, log, pnpmCalls }
  }
  catch (error) {
    return { line: null, error: error instanceof Error ? error.message : String(error), log, pnpmCalls }
  }
}

function refusal(run: Run): string {
  expect(run.line).toBeNull()
  return run.error ?? ''
}

describe('the preflight before ghosts:hash prints a hash', () => {
  it('prints the line for a sound brief with no sketch, and says no positive control was run', () => {
    const { repo } = world()
    const run = hashIn(repo, briefText({}))

    expect(run.line).toMatch(/^approved \/implement text sha256: [0-9a-f]{64} sketch: none /)
    expect(run.log).toContain('positive control: none (Sketch: none)')
  })

  it('prints the base it pinned and the time of each phase, on success and on refusal', () => {
    const { repo, base } = world()
    const ok = hashIn(repo, briefText({}))
    const refused = hashIn(repo, briefText({ acceptance: 'test -e README.md' }))

    expect(ok.log.at(-1)).toMatch(new RegExp(`^preflight: base ${base.slice(0, 7)}; .*P7 base \\d+\\.\\ds.*; total \\d+\\.\\ds$`))
    expect(refused.log.at(-1)).toMatch(new RegExp(`^preflight: base ${base.slice(0, 7)}; .*total \\d+\\.\\ds$`))
  })

  it('fetches origin/main and pins the sha it found there, not the stale remote-tracking ref', () => {
    const { repo, base } = world()
    const other = path.join(scratch(), 'other')
    execFileSync('git', ['clone', '-q', git(repo, 'remote', 'get-url', 'origin'), other])
    writeFiles(other, { 'moved.txt': 'm\n' })
    git(other, 'add', '-A')
    git(other, 'commit', '-q', '-m', 'moved')
    git(other, 'push', '-q', 'origin', 'main')
    const moved = git(other, 'rev-parse', 'HEAD')
    const run = hashIn(repo, briefText({}))

    expect(moved).not.toBe(base)
    expect(run.log.at(-1)).toContain(`base ${moved.slice(0, 7)};`)
  })

  it('prints the line for a sound brief with a sketch that makes the witness green, and ran the harness on it', () => {
    const { repo } = world()
    const sha = sketchOn(repo, { 'added.txt': 'x\n' })
    const run = hashIn(repo, briefText({ sketch: `Sketch: sketch/t @ ${sha}`, invariants: 'test -e README.md' }))

    expect(run.line).toContain(`sketch: ${sha} `)
    expect(run.pnpmCalls).toContain('pnpm run quality')
  })

  it('gives no hash for a brief the build refuses, before any tree is made', () => {
    const { repo } = world()
    const run = hashIn(repo, briefText({ acceptance: 'echo `date`' }))

    expect(refusal(run)).toMatch(/check-acceptance build exited 2/)
    expect(run.log).toEqual([])
  })

  it('refuses a witness that names the moving base ref and says to compare with HEAD', () => {
    const { repo } = world()
    const run = hashIn(repo, briefText({ acceptance: 'git diff --quiet origin/main -- added.txt' }))

    expect(refusal(run)).toMatch(/preflight P2: witness "the file exists" names origin\/main.*compare with HEAD/)
  })

  it('refuses an invariant that names the moving base ref', () => {
    const { repo } = world()
    const run = hashIn(repo, briefText({ invariants: 'git diff --quiet origin/main' }))

    expect(refusal(run)).toMatch(/preflight P2: witness "the readme is kept" names origin\/main/)
  })

  it('refuses an invariant whose witness it cannot read instead of skipping it', () => {
    const { repo } = world()
    const text = briefText({}).replace('Acceptance:', 'Invariants: the readme is kept.\n\nAcceptance:')
    const run = hashIn(repo, text)

    expect(refusal(run)).toContain('preflight P1: invariant "the readme is kept" carries no witness the preflight can read')
  })

  it('refuses a Design that names a generated path without the sentence that lets the implementer run its generator', () => {
    const { repo } = world()
    const run = hashIn(repo, briefText({ design: 'Regenerate templates/attach/earlier-carriers.json.' }))

    expect(refusal(run)).toContain('preflight P3: the brief names templates/attach/earlier-carriers.json, a generated path, and its Design lacks the sentence: The implementer runs `pnpm exec tsx scripts/attach/earlier-carriers.ts` without asking.')
  })

  it('accepts the same Design once it holds the sentence', () => {
    const { repo } = world()
    const design = 'Regenerate contract/surface.json. The implementer runs `pnpm contract:update` without asking.'

    expect(hashIn(repo, briefText({ design })).line).not.toBeNull()
  })

  it('refuses a Design that names a new file under scripts/ghosts that no list of owner-merges.md classifies', () => {
    const { repo } = world()
    const run = hashIn(repo, briefText({ design: 'Add scripts/ghosts/preflight.ts.' }))

    expect(refusal(run)).toContain('preflight P4: scripts/ghosts/preflight.ts is in no list of architecture/owner-merges.md: add it to the kind ghosts or to the plain list')
  })

  it('accepts a named file under scripts/ghosts that the plain list already classifies', () => {
    const { repo } = world()

    expect(hashIn(repo, briefText({ design: 'Change scripts/ghosts/status.ts.' })).line).not.toBeNull()
  })

  it('refuses a sketch that adds a scripts/ghosts file no list classifies', () => {
    const { repo } = world()
    const sha = sketchOn(repo, { 'added.txt': 'x\n', 'scripts/ghosts/fresh.ts': 'export {}\n' })
    const run = hashIn(repo, briefText({ sketch: `Sketch: sketch/t @ ${sha}` }))

    expect(refusal(run)).toContain('preflight P4: scripts/ghosts/fresh.ts is in no list')
  })

  it('refuses a sketch whose scripts/shift file now names a merge and is not own-instructions, naming the record to add', () => {
    const { repo } = world()
    const sha = sketchOn(repo, { 'added.txt': 'x\n', 'scripts/shift/parking.ts': 'export const merged = 1\n' })
    const run = hashIn(repo, briefText({ sketch: `Sketch: sketch/t @ ${sha}` }))

    expect(refusal(run)).toContain('preflight P4: scripts/shift/parking.ts names a merge and is not under own-instructions in architecture/owner-merges.md: add it to the kind own-instructions')
  })

  it('refuses a sketch that changes a path the brief holds Immutable', () => {
    const { repo } = world()
    const sha = sketchOn(repo, { 'added.txt': 'x\n', 'src/card/parking.ts': 'export {}\n' })
    const run = hashIn(repo, briefText({ sketch: `Sketch: sketch/t @ ${sha}`, immutable: 'src/card/' }))

    expect(refusal(run)).toContain('preflight P5: the sketch changes src/card/parking.ts, which the brief holds Immutable (src/card/)')
  })

  it('refuses a sketch that does not contain the pinned base', () => {
    const { repo } = world()
    const sha = sketchOn(repo, { 'added.txt': 'x\n' })
    writeFiles(repo, { 'newer.txt': 'n\n' })
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'newer')
    git(repo, 'push', '-q', 'origin', 'main')
    const run = hashIn(repo, briefText({ sketch: `Sketch: sketch/t @ ${sha}` }))

    expect(refusal(run)).toMatch(/preflight P0: sketch [0-9a-f]{7} does not contain origin\/main [0-9a-f]{7}; rebase sketch\/t/)
  })
})

describe('the preflight runs every witness verbatim on a clean tree of the pinned base', () => {
  it('refuses a witness that is already green on the base, which no implementation can make red', () => {
    const { repo, base } = world()
    const run = hashIn(repo, briefText({ acceptance: 'test -e README.md' }))

    expect(refusal(run)).toContain(`preflight P7: witness "the file exists" exits 0 on the clean base ${base.slice(0, 7)}`)
  })

  it('refuses the Acceptance item pnpm run quality, green on the base', () => {
    const { repo } = world()
    const run = hashIn(repo, briefText({ acceptance: 'pnpm run quality' }))

    expect(refusal(run)).toMatch(/preflight P7: witness "the file exists" exits 0 on the clean base/)
  })

  it('refuses a witness that is red on the base only because its command is missing', () => {
    const { repo } = world()
    const run = hashIn(repo, briefText({ acceptance: 'no-such-command-anywhere --flag' }))

    expect(refusal(run)).toMatch(/preflight P7: witness "the file exists" did not run on the base [0-9a-f]{7} \(exit 127/)
  })

  it('refuses an invariant that is red on the base', () => {
    const { repo } = world()
    const run = hashIn(repo, briefText({ invariants: 'test -e missing-on-base.txt' }))

    expect(refusal(run)).toMatch(/preflight P7: invariant "the readme is kept" exits 1 on the clean base/)
  })

  it('keeps a run of spaces inside a backticked witness when it runs an invariant on the base', () => {
    const { repo } = world({ ...BASE_FILES, 'notes.txt': 'a  b\n' })
    const run = hashIn(repo, briefText({ invariants: 'grep -q \'a  b\' notes.txt' }))

    expect(run.error).toBeNull()
    expect(run.line).toMatch(/^approved \/implement text sha256: [0-9a-f]{64} /)
  })

  it('runs the witnesses with nothing of the sketch in the tree: a witness the sketch makes green is red on the base', () => {
    const { repo } = world()
    const sha = sketchOn(repo, { 'added.txt': 'x\n' })

    expect(hashIn(repo, briefText({ sketch: `Sketch: sketch/t @ ${sha}` })).line).not.toBeNull()
  })

  it('lays the ready witness files only after the witnesses ran on the base', () => {
    const { repo } = world()
    const ready = 'scripts/tests/ghosts/w.test.ts'
    const run = hashIn(repo, briefText({ acceptance: `test -e ${ready}` }), {}, { [ready]: 'export {}\n' })

    expect(run.line).not.toBeNull()
    expect(run.pnpmCalls).toContain(`pnpm exec eslint ${ready}`)
  })

  it('installs from the lockfile before the witnesses and refuses when the install fails', () => {
    const { repo, base } = world({ ...BASE_FILES, 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n' })
    const green = hashIn(repo, briefText({}))
    const red = hashIn(repo, briefText({}), { 'pnpm install': 1 })

    expect(green.pnpmCalls[0]).toBe('pnpm install --frozen-lockfile')
    expect(refusal(red)).toContain(`preflight P7: pnpm install --frozen-lockfile failed on the base ${base.slice(0, 7)}`)
  })

  it('runs an invariant that is the harness command on the base when there is no sketch, since no harness runs', () => {
    const { repo } = world()
    const run = hashIn(repo, briefText({ invariants: 'pnpm run quality' }), { 'pnpm run quality': 1 })

    expect(refusal(run)).toMatch(/preflight P7: invariant "the readme is kept" exits 1 on the clean base/)
    expect(run.log).not.toContain('I1: covered by harness')
  })

  it('removes the trees it made', () => {
    const { repo } = world()
    hashIn(repo, briefText({ acceptance: 'test -e README.md' }))

    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
  })
})

describe('the preflight holds a sketch to the base it will be staged on', () => {
  it('refuses a sketch on which an Acceptance witness is still red, naming the witness', () => {
    const { repo } = world()
    const sha = sketchOn(repo, { 'other.txt': 'x\n' })
    const run = hashIn(repo, briefText({ sketch: `Sketch: sketch/t @ ${sha}` }))

    expect(refusal(run)).toMatch(/preflight P8: positive control "the file exists" exits 1 on the sketch [0-9a-f]{7} staged on the base/)
  })

  it('refuses a sketch on which an invariant green on the base turns red', () => {
    const { repo } = world()
    const sha = sketchOn(repo, { 'added.txt': 'x\n', 'broken.txt': 'x\n' })
    const run = hashIn(repo, briefText({ sketch: `Sketch: sketch/t @ ${sha}`, invariants: 'test ! -e broken.txt' }))

    expect(refusal(run)).toMatch(/preflight P8: invariant "the readme is kept" exits 1 on the sketch [0-9a-f]{7} staged on the base/)
  })

  it('runs an invariant that is the harness command once, as the harness, and says it is covered by harness', () => {
    const { repo } = world()
    const sha = sketchOn(repo, { 'added.txt': 'x\n' })
    const run = hashIn(repo, briefText({ sketch: `Sketch: sketch/t @ ${sha}`, invariants: 'pnpm run quality' }))

    expect(run.line).not.toBeNull()
    expect(run.log).toContain('I1: covered by harness')
    expect(run.pnpmCalls.filter(call => call === 'pnpm run quality')).toHaveLength(1)
  })

  it('refuses a sketch whose harness command is red, which the ladder would stop on as a red base', () => {
    const { repo } = world()
    const sha = sketchOn(repo, { 'added.txt': 'x\n' })
    const run = hashIn(repo, briefText({ sketch: `Sketch: sketch/t @ ${sha}` }), { 'pnpm run quality': 1 })

    expect(refusal(run)).toMatch(/preflight P8: harness "pnpm run quality" exits 1 on the sketch/)
  })

  it('checks the earlier carriers on a sketch that touches an attach carrier, and refuses when they drift', () => {
    const { repo } = world()
    const sha = sketchOn(repo, { 'added.txt': 'x\n', 'templates/ai/claude/_claude/skills/x.md': 'x\n' })
    const text = briefText({ sketch: `Sketch: sketch/t @ ${sha}` })

    expect(hashIn(repo, text).pnpmCalls).toContain('pnpm exec tsx scripts/attach/earlier-carriers.ts --check')
    expect(refusal(hashIn(repo, text, { 'pnpm exec tsx scripts/attach': 1 }))).toMatch(/preflight P9: earlier-carriers --check "the known set" exits 1/)
  })

  it('does not check the earlier carriers for a sketch that touches none', () => {
    const { repo } = world()
    const sha = sketchOn(repo, { 'added.txt': 'x\n' })

    expect(hashIn(repo, briefText({ sketch: `Sketch: sketch/t @ ${sha}` })).pnpmCalls).not.toContain('pnpm exec tsx scripts/attach/earlier-carriers.ts --check')
  })

  it('lints the sketch test files without --fix and refuses on a finding', () => {
    const { repo } = world()
    const sha = sketchOn(repo, { 'added.txt': 'x\n', 'scripts/tests/ghosts/w.test.ts': 'export {}\n' })
    const text = briefText({ sketch: `Sketch: sketch/t @ ${sha}` })
    const green = hashIn(repo, text)
    const red = hashIn(repo, text, { 'pnpm exec eslint': 1 })

    expect(green.pnpmCalls).toContain('pnpm exec eslint scripts/tests/ghosts/w.test.ts')
    expect(refusal(red)).toMatch(/preflight P6: lint of the sketch test files, no --fix, "scripts\/tests\/ghosts\/w.test.ts" exits 1/)
  })

  it('lints the ready witness files kept beside a brief with no sketch, in a throwaway tree', () => {
    const { repo } = world()
    const text = briefText({})
    const brief = briefFile(text)
    const witnesses = `${brief.replace(/\.md$/, '')}.witnesses/scripts/tests/ghosts`
    mkdirSync(witnesses, { recursive: true })
    writeFileSync(path.join(witnesses, 'w.test.ts'), 'export {}\n')
    const calls: string[] = []
    const shell: Shell = (command, cwd) => {
      if (!command.startsWith('pnpm'))
        return realShell(command, cwd)
      calls.push(command)
      return { status: 1, output: 'lint finding' }
    }
    const env: PreflightEnv = { repo, shell, log: () => {}, clock: () => 0 }

    expect(() => approvalLine(brief, NOW, APPROVER, checkAcceptanceBuild, input => runPreflight(input, env))).toThrow(/preflight P6: lint of the ready witness files, no --fix, "scripts\/tests\/ghosts\/w.test.ts" exits 1/)
    expect(calls).toEqual(['pnpm exec eslint scripts/tests/ghosts/w.test.ts'])
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })
})

describe('realShell witness environment', () => {
  function withCallerEnv<T>(patch: Record<string, string | undefined>, run: () => T): T {
    const saved = { ...process.env }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }
    try {
      return run()
    }
    finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved))
          delete process.env[key]
      }
      Object.assign(process.env, saved)
    }
  }

  it('witness environment: gives the command NO_COLOR=1 and no FORCE_COLOR', () => {
    const result = withCallerEnv({ NO_COLOR: undefined, FORCE_COLOR: '1', CLICOLOR_FORCE: '1' }, () => realShell('echo "$NO_COLOR/$(env | grep -c ^FORCE_COLOR=)/$(env | grep -c ^CLICOLOR_FORCE=)"', process.cwd()))
    expect(result.output.trim()).toBe('1/0/0')
  })

  it('counts a tick right whatever the colour of the caller', () => {
    const command = `node -e "const c=process.env.FORCE_COLOR&&!process.env.NO_COLOR;console.log((c?'\\u001b[32m✓\\u001b[0m':'✓')+' ok')" | grep -Ec '✓ '`
    const result = withCallerEnv({ NO_COLOR: undefined, FORCE_COLOR: '1', COLORTERM: 'truecolor' }, () => realShell(command, process.cwd()))
    expect(result.output.trim()).toBe('1')
  })
})
