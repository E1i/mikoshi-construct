import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalImplementText } from '../scripts/ghosts/approval.js'
import { parseSketch } from '../scripts/ghosts/sketch.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(ROOT, 'scripts/construct/check-acceptance.mjs')
const FACTORY_COPY = '.claude/commands/plan.md'
const TEMPLATE_COPY = 'templates/ai/claude/_claude/commands/plan.md'
const COPIES = [FACTORY_COPY, TEMPLATE_COPY]
const PLACEHOLDERS_BEFORE_EFFORT: Record<string, number> = { [FACTORY_COPY]: 3, [TEMPLATE_COPY]: 1 }
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
  execFileSync('git', ['init', '--quiet', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=a@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'sketch'])
  const sketchSha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  writeFileSync(path.join(dir, 'brief.md'), brief.replace(/^(Sketch: \S+ @ )[0-9a-f]{40}$/m, `$1${sketchSha}`))
  const child = spawnSync(process.execPath, [SCRIPT, 'build', '--brief', path.join(dir, 'brief.md')], { cwd: dir, encoding: 'utf8' })
  return { status: child.status, stdout: child.stdout, stderr: child.stderr }
}

describe('the brief skeleton /plan outputs for a ladder-path task', () => {
  it.each(COPIES)('in %s, once filled in, is parsed by the implement build into every section', (copy) => {
    const result = build(fillPlaceholders(skeletonIn(copy)))
    const p = (n: number): string => `p${PLACEHOLDERS_BEFORE_EFFORT[copy] + n}`

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      task: 'p1',
      effort: p(1),
      design: `- ${p(3)}`,
      acceptance: [p(4), p(6)],
      witnesses: [{ criterion: p(4), command: p(5) }, { criterion: p(6), command: p(7) }],
      invariants: [p(8)],
      immutable: [p(9), p(10)],
    })
  })

  it('in the factory copy, once filled in, names its sketch on the line the launcher reads', () => {
    const text = canonicalImplementText(fillPlaceholders(skeletonIn(FACTORY_COPY)))!

    expect(parseSketch(text)).toEqual({ kind: 'branch', branch: 'p2', sha: '3'.padStart(40, '0') })
  })

  it('in the factory copy, filled in with the no-sketch form it documents, is read by the launcher as a clean start', () => {
    const lines = fillPlaceholders(skeletonIn(FACTORY_COPY)).split('\n')
    lines[1] = noSketchLineIn(FACTORY_COPY)

    expect(parseSketch(canonicalImplementText(lines.join('\n'))!)).toEqual({ kind: 'none', reason: 'no sketch for this task' })
  })

  it('in the template copy, which ships to repositories with no launcher, carries no Sketch: line', () => {
    expect(readFileSync(path.join(ROOT, TEMPLATE_COPY), 'utf8')).not.toContain('Sketch:')
  })

  it.each(COPIES)('in %s, pasted with its placeholders unfilled, is refused by the build', (copy) => {
    const result = build(skeletonIn(copy))

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('bash -n')
  })
})
