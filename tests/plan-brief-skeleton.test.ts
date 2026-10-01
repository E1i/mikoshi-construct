import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalImplementText } from '../scripts/ghosts/approval.js'
import { parseSketch } from '../scripts/ghosts/sketch.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(ROOT, 'scripts/construct/check-acceptance.mjs')
const COPIES = ['.claude/commands/plan.md', 'templates/ai/claude/_claude/commands/plan.md']
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function skeletonIn(copy: string): string {
  const text = readFileSync(path.join(ROOT, copy), 'utf8')
  const block = /\n```text\n([\s\S]*?)\n```\n/.exec(text)
  expect(block, copy).not.toBeNull()
  return block![1]
}

const SKETCH_SHA_PLACEHOLDER = '<40-hex sha>'

function fillPlaceholders(skeleton: string): string {
  let next = 0
  return skeleton.replace(/<[^>]+>/g, (placeholder) => {
    next += 1
    return placeholder === SKETCH_SHA_PLACEHOLDER ? next.toString(16).padStart(40, '0') : `p${next}`
  })
}

function noSketchLineIn(copy: string): string {
  const text = readFileSync(path.join(ROOT, copy), 'utf8')
  const form = /`(Sketch: none — <reason>)`/.exec(text)
  expect(form, copy).not.toBeNull()
  return form![1].replace('<reason>', 'no sketch for this task')
}

function build(brief: string): { status: number | null, stdout: string, stderr: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-brief-skeleton-'))
  dirs.push(dir)
  writeFileSync(path.join(dir, 'construct.json'), JSON.stringify({ harness: { command: 'pnpm run quality' }, contracts: null }))
  writeFileSync(path.join(dir, 'brief.md'), brief)
  const child = spawnSync(process.execPath, [SCRIPT, 'build', '--brief', path.join(dir, 'brief.md')], { cwd: dir, encoding: 'utf8' })
  return { status: child.status, stdout: child.stdout, stderr: child.stderr }
}

describe('the brief skeleton /plan outputs for a ladder-path task', () => {
  it('is the same text in the repository copy and the template copy', () => {
    expect(readFileSync(path.join(ROOT, COPIES[0]), 'utf8')).toBe(readFileSync(path.join(ROOT, COPIES[1]), 'utf8'))
  })

  it.each(COPIES)('in %s, once filled in, is parsed by the implement build into every section', (copy) => {
    const result = build(fillPlaceholders(skeletonIn(copy)))

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      task: 'p1',
      effort: 'p4',
      design: '- p6',
      acceptance: ['p7', 'p9'],
      witnesses: [{ criterion: 'p7', command: 'p8' }, { criterion: 'p9', command: 'p10' }],
      invariants: ['p11'],
      immutable: ['p12', 'p13'],
    })
  })

  it.each(COPIES)('in %s, once filled in, names its sketch on the line the launcher reads', (copy) => {
    const text = canonicalImplementText(fillPlaceholders(skeletonIn(copy)))!

    expect(parseSketch(text)).toEqual({ kind: 'branch', branch: 'p2', sha: '3'.padStart(40, '0') })
  })

  it.each(COPIES)('in %s, filled in with the no-sketch form it documents, is read by the launcher as a clean start', (copy) => {
    const lines = fillPlaceholders(skeletonIn(copy)).split('\n')
    lines[1] = noSketchLineIn(copy)

    expect(parseSketch(canonicalImplementText(lines.join('\n'))!)).toEqual({ kind: 'none', reason: 'no sketch for this task' })
  })

  it.each(COPIES)('in %s, pasted with its placeholders unfilled, is refused by the build', (copy) => {
    const result = build(skeletonIn(copy))

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('bash -n')
  })
})
