import type { Options } from 'tsup'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { build } from 'tsup'
import { afterEach, describe, expect, it } from 'vitest'
import { BUS_DB_VARIABLE } from '../scripts/bus/db.js'
import productBuild from '../tsup.config.js'

const REPOSITORY = path.resolve(import.meta.dirname, '..')
const BUS_SOURCE = 'scripts/bus/'
const BUS_STORE_READER = 'src/commands/cost/bus.ts'
const BUS_STORE_MENTION = /sqlite/i
const BUILTIN_REACH = /getBuiltinModule\(([^)]*)\)/g
const BUS_STORE_MODULE = /["'`]node:sqlite["'`]/g
const BUS_STORE_OPEN = /DatabaseSync\(([^)]*)\)/g
const READ_ONLY_OPEN = /readOnly:\s*true/
const BUS_WRITE_STATEMENT = /\b(?:INSERT\s+INTO|CREATE\s+(?:TABLE|INDEX|TRIGGER|VIEW)|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|UPDATE\s+\w+\s+SET)\b/
const BUILD_TIMEOUT_MS = 120_000

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'delivery-boundary-'))
  roots.push(root)
  return root
}

function scratchBesideDependencies(): string {
  const cache = path.join(REPOSITORY, 'node_modules', '.cache')
  mkdirSync(cache, { recursive: true })
  const outDir = mkdtempSync(path.join(cache, 'delivery-boundary-'))
  roots.push(outDir)
  return outDir
}

interface ProductBundle { cli: string, inputs: string[] }

async function buildProduct(outDir: string): Promise<ProductBundle> {
  await build({ ...(productBuild as Options), outDir, metafile: true, silent: true, config: false })
  const metafile = JSON.parse(readFileSync(path.join(outDir, 'metafile-esm.json'), 'utf8')) as { inputs: Record<string, unknown> }
  return { cli: path.join(outDir, 'cli.js'), inputs: Object.keys(metafile.inputs) }
}

describe('the delivery boundary between the product and the factory', () => {
  it('the product build carries no bus code, opens the bus store only read-only, and the cli runs without the bus writer', async () => {
    const root = scratch()
    const bundle = await buildProduct(scratchBesideDependencies())
    expect(bundle.inputs.some(input => input.startsWith('src/'))).toBe(true)
    expect(bundle.inputs.filter(input => input.startsWith(BUS_SOURCE))).toEqual([])
    expect(bundle.inputs.filter(input => input.startsWith('src/') && BUS_STORE_MENTION.test(readFileSync(path.join(REPOSITORY, input), 'utf8')))).toEqual([BUS_STORE_READER])
    const cli = readFileSync(bundle.cli, 'utf8')
    expect([...cli.matchAll(BUILTIN_REACH)].map(([, module]) => module)).toEqual(['"node:sqlite"'])
    expect(cli.match(BUS_STORE_MODULE)).toEqual(['"node:sqlite"'])
    const opens = [...cli.matchAll(BUS_STORE_OPEN)].map(([, options]) => options)
    expect(opens).toHaveLength(1)
    expect(opens[0]).toMatch(READ_ONLY_OPEN)
    expect(cli).not.toMatch(BUS_WRITE_STATEMENT)

    const repo = path.join(root, 'repo')
    mkdirSync(path.join(repo, 'src'), { recursive: true })
    writeFileSync(path.join(repo, 'src', 'a.ts'), '')
    const draft = path.join(root, 'draft.json')
    writeFileSync(draft, JSON.stringify({ cards: [{ name: 'boundary-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', who: 'shift', touches: ['src/a.ts'], task: 'Cross the boundary.', witnesses: ['`pnpm run quality` is green'] }] }))
    const taken = path.join(root, 'taken.txt')
    writeFileSync(taken, '12\n')
    const parking = path.join(root, 'parking')
    const journal = path.join(root, 'handoff', 'ghosts.jsonl')
    const run = spawnSync(process.execPath, [bundle.cli, 'intake', '--draft', draft, '--taken', taken, '--parking', parking, '--journal', journal, '--dir', repo, '--plain'], { cwd: root, encoding: 'utf8', env: { ...process.env, [BUS_DB_VARIABLE]: path.join(root, 'bus.db') } })
    expect(run.status, run.stderr).toBe(0)
    expect(existsSync(path.join(parking, '13.md'))).toBe(true)
    expect(readFileSync(journal, 'utf8')).toContain('"event":"intake"')
    expect(existsSync(path.join(root, 'bus.db'))).toBe(false)
  }, BUILD_TIMEOUT_MS)
})
