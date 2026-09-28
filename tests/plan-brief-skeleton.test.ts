import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

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

function fillPlaceholders(skeleton: string): string {
  let next = 0
  return skeleton.replace(/<[^>]+>/g, () => `p${++next}`)
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
      effort: 'p2',
      design: '- p4',
      acceptance: ['p5', 'p7'],
      witnesses: [{ criterion: 'p5', command: 'p6' }, { criterion: 'p7', command: 'p8' }],
      invariants: ['p9'],
      immutable: ['p10', 'p11'],
    })
  })

  it.each(COPIES)('in %s, pasted with its placeholders unfilled, is refused by the build', (copy) => {
    const result = build(skeletonIn(copy))

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('bash -n')
  })
})
