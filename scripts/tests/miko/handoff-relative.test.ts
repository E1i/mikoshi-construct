import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { repoHome, repoIdOf } from '../../core/bus-path.js'
import { HANDOFF_DIR } from '../../core/handoff-dir.js'
import { HANDOFF_FIELDS } from '../../core/handoff-fields.js'
import { MIKO_HANDOFF_NAME } from '../../window/loop.js'

const MIKO = fileURLToPath(new URL('../../window/miko.ts', import.meta.url))
const TSX_LOADER = pathToFileURL(path.resolve(import.meta.dirname, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href
const DECISIONS = fileURLToPath(import.meta.url)
const FOREIGN_REMOTE = 'git@github.com:someone/fresh.git'

interface Fresh {
  home: string
  repo: string
  handoffDir: string
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function freshRepository(): Fresh {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'handoff-relative-')))
  roots.push(root)
  const home = path.join(root, 'home')
  const repo = path.join(root, 'repo')
  mkdirSync(home, { recursive: true })
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', FOREIGN_REMOTE])
  return { home, repo, handoffDir: path.join(repoHome(home, repoIdOf(repo)), HANDOFF_DIR) }
}

function draft(): string {
  const values = Object.fromEntries(HANDOFF_FIELDS.filter(field => field.id !== 'stop-reason').map(field => [field.label, field.id === 'decisions' ? DECISIONS : `${field.id} value`]))
  return `# Handoff\n\nrole: window\nsession: 1\n${Object.entries({ ...values, 'queue': 'none', 'in-flight': 'none', 'next task': '#1 brief', 'owner waits': 'none' }).map(([label, value]) => `${label}: ${value}`).join('\n')}\n\nSTATUS: CONTINUE\n`
}

function miko(fresh: Fresh, args: string[]): { status: number | null, stderr: string } {
  const { CONSTRUCT_BUS_DB: _bus, CONSTRUCT_HANDOFF: _handoff, CONSTRUCT_HANDOFF_DIR: _dir, CONSTRUCT_CARD: _card, MIKO_LOOP_PID: _loop, MIKO_EXIT_REQUEST: _request, MIKO_WINDOW: _window, CLAUDE_PROJECT_DIR: _project, ...env } = process.env
  const run = spawnSync(process.execPath, ['--import', TSX_LOADER, MIKO, ...args], { cwd: fresh.repo, env: { ...env, HOME: fresh.home, NODE_NO_WARNINGS: '1' }, encoding: 'utf8' })
  return { status: run.status, stderr: run.stderr }
}

describe('a relative handoff name resolves against the repository\'s handoff directory', () => {
  it('miko handoff write miko.md from the root of a fresh repository creates its first handoff there and leaves nothing in cwd', () => {
    const fresh = freshRepository()
    writeFileSync(path.join(fresh.home, 'draft.md'), draft())
    const before = readdirSync(fresh.repo)
    const run = miko(fresh, ['handoff', 'write', MIKO_HANDOFF_NAME, path.join(fresh.home, 'draft.md')])
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(readFileSync(path.join(fresh.handoffDir, MIKO_HANDOFF_NAME), 'utf8')).toContain('STATUS: CONTINUE')
    expect(readdirSync(fresh.repo)).toEqual(before)
  }, 30_000)

  it('miko handoff check miko.md from the same root reads the handoff miko handoff write created', () => {
    const fresh = freshRepository()
    writeFileSync(path.join(fresh.home, 'draft.md'), draft())
    expect(miko(fresh, ['handoff', 'write', MIKO_HANDOFF_NAME, path.join(fresh.home, 'draft.md')]).status).toBe(0)
    expect(existsSync(path.join(fresh.repo, MIKO_HANDOFF_NAME))).toBe(false)
    const run = miko(fresh, ['handoff', 'check', MIKO_HANDOFF_NAME])
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
  }, 30_000)
})
