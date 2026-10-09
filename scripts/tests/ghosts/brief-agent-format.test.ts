import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { applyMutation, runJudge } from '../../../src/commands/mutate/index.js'
import { failing, MutateWorld, passing } from '../../../tests/mutate-world.js'
import { doneCheck } from '../../done/check.js'
import { realShell } from '../../ghosts/preflight-trees.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const BRIEF_AGENT = path.join(REPO_ROOT, '.claude/agents/brief.md')
const CHECK_ACCEPTANCE = path.join(REPO_ROOT, 'scripts/construct/check-acceptance.mjs')
const FENCED_TEXT_BLOCK = /```text\n([\s\S]*?)```/g
const PLACEHOLDER = /<[^>]+>/g

const TOTAL = 'function add(sum: number, item: number): number {\n  return sum + item\n}\n\nexport function total(items: number[]): number {\n  return items.reduce(add, 0)\n}\n'
const TOTAL_TEST = 'import { describe, expect, it } from \'vitest\'\nimport { total } from \'../src/total.js\'\n\ndescribe(\'total\', () => {\n  it(\'sums the items\', () => {\n    expect(total([1, 2])).toBe(3)\n  })\n})\n'
const WIRED_APP = 'import { total } from \'./total.js\'\n\nexport function main(): number {\n  return total([1, 2])\n}\n'
const TEST_FILE = 'tests/total.test.ts'
const DESCRIBE = 'total'
const TITLE = 'sums the items'

const FILLED: Record<string, string> = {
  '<file>': 'src/total.ts',
  '<old>': 'sum + item',
  '<new>': 'sum - item',
  '<test file>': TEST_FILE,
  '<describe>': DESCRIBE,
  '<title>': TITLE,
  '<message>': 'expected -3 to be 3',
}

const OLD_FORMAT_SECTIONS = [
  'Design:',
  '- 1. total sums its items.',
  '- 2. the app shows the total.',
  '',
  'Mutations:',
  `M1 | src/total.ts | find: \`sum + item\` → \`sum - item\` | red: \`${TITLE}\` | \`expected -3 to be 3\``,
].join('\n')

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function temporary(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

function agentSections(): string {
  const blocks = [...readFileSync(BRIEF_AGENT, 'utf8').matchAll(FENCED_TEXT_BLOCK)].map(found => found[1]!)
  const sections = blocks.find(block => block.includes('Design:') && block.includes('Mutations:'))
  expect(sections, `${path.relative(REPO_ROOT, BRIEF_AGENT)} shows no Design: and Mutations: sections in a text block`).toBeDefined()
  return sections!.replace(PLACEHOLDER, placeholder => FILLED[placeholder] ?? 'a decision')
}

function briefWith(sections: string): string {
  const brief = path.join(temporary('brief-format-'), 'brief.md')
  writeFileSync(brief, `/implement the total sums the items\nSketch: none — a fixture\n\nEffort: medium — a fixture.\n\nAcceptance: the total sums the items — witness: \`true\`\n\n${sections}\n`)
  return brief
}

function argsOf(brief: string): string {
  const built = spawnSync(process.execPath, [CHECK_ACCEPTANCE, 'build', '--brief', brief], { encoding: 'utf8' })
  expect(built.stderr).toBe('')
  expect(built.status).toBe(0)
  const args = `${brief}.args.json`
  writeFileSync(args, built.stdout)
  return args
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim()
}

function put(root: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), text)
}

function implementedTree(): { root: string, base: string } {
  const root = temporary('brief-format-tree-')
  git(root, ['init', '-q'])
  put(root, 'package.json', '{"name":"fixture","type":"module","bin":"src/cli.ts"}\n')
  put(root, 'src/cli.ts', 'import { main } from \'./app.js\'\n\nmain()\n')
  put(root, 'src/app.ts', 'export function main(): number {\n  return 1\n}\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'base'])
  const base = git(root, ['rev-parse', 'HEAD'])
  put(root, 'src/total.ts', TOTAL)
  put(root, 'src/app.ts', WIRED_APP)
  put(root, TEST_FILE, TOTAL_TEST)
  return { root, base }
}

function doneCheckOver(args: string, ids: string[]): { passed: boolean, lines: string[] } {
  const { root, base } = implementedTree()
  const map = path.join(temporary('brief-format-map-'), 'map.json')
  writeFileSync(map, JSON.stringify({ requirements: ids.map(id => ({ id, code: ['src/total.ts:6'], tests: [{ file: TEST_FILE, title: TITLE }] })) }))
  return doneCheck(root, { args, map, base, task: null }, { shell: realShell, journal: path.join(temporary('brief-format-handoff-'), 'ghosts.jsonl') })
}

function mutationWorld(): MutateWorld {
  const world = new MutateWorld()
  scratch.push(path.dirname(world.root))
  world.write('src/total.ts', TOTAL)
  const green = world.report('green.json', Date.now(), [passing(TEST_FILE, DESCRIBE, TITLE)])
  expect(runJudge({ dir: world.root, report: green, baseline: true }).status).toBe('baseline-recorded')
  return world
}

describe('the brief agent writes the form the tools read', () => {
  it('a brief in the agent format passes done:check and construct mutate unchanged', () => {
    const brief = briefWith(agentSections())

    const done = doneCheckOver(argsOf(brief), ['A1', 'D1', 'D2'])
    expect(done.passed, done.lines.join('\n')).toBe(true)
    expect(done.lines[1]).toMatch(/^3 requirements mapped, /)

    const world = mutationWorld()
    expect(applyMutation({ dir: world.root, from: brief, id: 'M1' }).status).toBe('applied')
    const red = world.report('red.json', Date.now() + 1000, [failing(TEST_FILE, DESCRIBE, TITLE)])
    expect(runJudge({ dir: world.root, report: red, id: 'M1' })).toMatchObject({ status: 'judged', outcome: 'named-red', matched: true })
  })

  it('a brief in the old format is refused naming the field', () => {
    const brief = briefWith(OLD_FORMAT_SECTIONS)

    const done = doneCheckOver(argsOf(brief), ['A1', 'D1', 'D2'])
    expect(done).toEqual({ passed: false, lines: ['FAIL', 'requirements:', '  D1: the brief has no such requirement', '  D2: the brief has no such requirement'] })

    const world = mutationWorld()
    expect(applyMutation({ dir: world.root, from: brief, id: 'M1' })).toMatchObject({ status: 'refused', refusal: 'malformed-line', detail: expect.stringContaining('the red field') })
    expect(world.bytes('src/total.ts').toString()).toBe(TOTAL)
  })
})
