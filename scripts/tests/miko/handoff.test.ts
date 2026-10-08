import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HANDOFF_FIELDS, HANDOFF_LIMIT } from '../../ghosts/handoff-check.js'
import { mikoshiHandoff, runMikoHandoff } from '../../miko/handoff.js'
import { runHandoffWrite } from '../../shift/handoff-write.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const HANDOFF = path.join(REPO_ROOT, 'scripts', 'miko', 'handoff.ts')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const RECORDING_OSASCRIPT = '#!/bin/sh\nfor arg in "$@"; do printf \'%s\\0\' "$arg"; done > "$OSASCRIPT_ARGS"\n'
const EXPECTED_SCRIPT = 'tell app "Terminal" to do script "cd ~/projects/mikoshi-construct && GH_TOKEN=$(gh auth token --user E1i) caffeinate -dis claude --permission-mode auto \\"Прочитай ~/.construct/handoff/mikoshi.md и продолжай как Mikoshi\\""'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'miko-handoff-'))
  roots.push(dir)
  mkdirSync(path.join(dir, '.construct', 'handoff'), { recursive: true })
  writeFileSync(path.join(dir, '.construct', 'owner-decisions.md'), '# Owner decisions\n')
  return dir
}

function draft(stops = 1, extra = ''): string {
  const values: Record<string, string> = { ...Object.fromEntries(HANDOFF_FIELDS.map(field => [field.label, field.id === 'decisions' ? '~/.construct/owner-decisions.md' : `${field.id} value`])), 'queue': 'none', 'in-flight': 'none' }
  const fields = Object.entries(values).map(([label, value]) => `${label}: ${value}`).join('\n')
  const stopSections = Array.from({ length: stops }, (_, index) => `## STOP — Mikoshi window ${index + 1}\n${fields}\n`).join('\n')
  return `# Mikoshi handoff\n\n${stopSections}${extra}\nSTATUS: CONTINUE\n`
}

function writeThroughCommand(dir: string, text: string): number {
  const draftFile = path.join(dir, 'draft.md')
  writeFileSync(draftFile, text)
  return runHandoffWrite([mikoshiHandoff(dir), draftFile], {
    cwd: dir,
    handoffDir: undefined,
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    listDir: readdirSync,
    makeDir: target => mkdirSync(target, { recursive: true }),
    write: (file, content) => writeFileSync(file, content),
    writeNew: (file, content) => writeFileSync(file, content, { flag: 'wx' }),
    rename: renameSync,
    parked: () => new Map(),
    home: dir,
    out: () => {},
    err: () => {},
  })
}

function handOn(dir: string): { code: number, opened: string[], err: string[] } {
  const opened: string[] = []
  const err: string[] = []
  const code = runMikoHandoff({
    home: dir,
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    parked: () => new Map(),
    openTerminal: script => opened.push(script),
    err: line => err.push(line),
  })
  return { code, opened, err }
}

describe('the foreman handoff (mikoshi.md) is held to the handoff contract', () => {
  it('opens the next Mikoshi only from a foreman handoff written by pnpm handoff:write, with prev: to the archive', () => {
    const dir = home()
    expect(writeThroughCommand(dir, draft())).toBe(0)
    expect(handOn(dir)).toEqual({ code: 0, opened: [EXPECTED_SCRIPT], err: [] })
    expect(writeThroughCommand(dir, draft())).toBe(0)
    expect(readFileSync(mikoshiHandoff(dir), 'utf8')).toContain('prev: archive/0001.md')
    expect(existsSync(path.join(dir, '.construct', 'handoff', 'archive', '0001.md'))).toBe(true)
    expect(handOn(dir).code).toBe(0)
  })

  it('refuses a foreman handoff edited by hand, with no prev:, and opens no Terminal', () => {
    const dir = home()
    writeFileSync(mikoshiHandoff(dir), draft())
    const result = handOn(dir)
    expect(result.code).toBe(1)
    expect(result.opened).toEqual([])
    expect(result.err[0]).toContain('[handoff:check] missing: prev')
  })

  it('refuses a foreman handoff with two STOP sections, over the limit or missing a field, and the command refuses the draft', () => {
    const dir = home()
    expect(writeThroughCommand(dir, draft(2))).toBe(1)
    expect(writeThroughCommand(dir, draft(1, `\nnotes: ${'x'.repeat(HANDOFF_LIMIT)}\n`))).toBe(1)
    expect(writeThroughCommand(dir, draft().replace(/^journal:.*$/m, ''))).toBe(1)
    expect(existsSync(mikoshiHandoff(dir))).toBe(false)
    expect(handOn(dir)).toMatchObject({ code: 1, opened: [] })
  })

  it('hands osascript exactly the card\'s script and nothing else', () => {
    const dir = home()
    expect(writeThroughCommand(dir, draft())).toBe(0)
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    const recorded = path.join(bin, 'args')
    writeFileSync(path.join(bin, 'osascript'), RECORDING_OSASCRIPT, { mode: 0o755 })
    execFileSync(TSX, [HANDOFF], { env: { ...process.env, HOME: dir, PATH: `${bin}${path.delimiter}${process.env.PATH}`, OSASCRIPT_ARGS: recorded }, stdio: 'pipe' })
    expect(readFileSync(recorded, 'utf8').split('\0').slice(0, -1)).toEqual(['-e', EXPECTED_SCRIPT])
  })
})
