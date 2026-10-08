import type { RelaunchDeps } from '../../shift/relaunch.js'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HANDOFF_FIELDS } from '../../ghosts/handoff-check.js'
import { runClaude } from '../../shift/claude.js'
import { runRelaunch } from '../../shift/relaunch.js'

const STUB = path.join(import.meta.dirname, 'fixtures', 'claude-stub-brain.sh')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function brainWorld(): { deps: RelaunchDeps, handoff: string, stubOut: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'relaunch-e2e-')))
  roots.push(root)
  const stubOut = path.join(root, 'stub-out')
  mkdirSync(stubOut)
  const handoff = path.join(root, 'handoff.md')
  writeFileSync(handoff, `## STOP — window 1\nprev: none\nin-flight: none\n${HANDOFF_FIELDS.map(field => `${field.label}: ${field.label === 'queue' ? 'none' : field.id === 'decisions' ? handoff : 'x'}`).join('\n')}\nSTATUS: CONTINUE\n`)
  const deps: RelaunchDeps = {
    cwd: root,
    home: root,
    claude: `STUB_OUT=${stubOut} ${STUB}`,
    journal: path.join(root, 'handoff-dir', 'ghosts.jsonl'),
    projectsDir: path.join(root, 'projects'),
    read: file => readFileSync(file, 'utf8'),
    exists: existsSync,
    parked: () => new Map(),
    listDir: dir => existsSync(dir) ? readdirSync(dir) : [],
    modified: file => statSync(file).mtimeMs,
    now: () => new Date('2026-10-08T12:00:00.000Z'),
    uuid: () => '00000000-0000-4000-8000-000000000001',
    run: runClaude,
    alive: () => false,
    out: () => {},
    err: () => {},
  }
  return { deps, handoff, stubOut }
}

describe('relaunch end to end', () => {
  it('a relaunch session with stub claude starts the shift, not task:start', async () => {
    const world = brainWorld()
    expect(await runRelaunch([world.handoff, '--max', '1', '--model', 'claude-test'], world.deps)).toBe(0)
    const started = readFileSync(path.join(world.stubOut, 'started'), 'utf8').trim()
    expect(started).toMatch(/^pnpm shift \S+ --parking \S+ --chain$/)
    expect(started).not.toContain('task:start')
  })
})
