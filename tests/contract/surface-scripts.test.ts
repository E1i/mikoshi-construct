import type { ScriptSurface, Surface } from '../../scripts/contract/surface.js'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REFUSAL_NOT_READ, REFUSED_BY_STRICT_PARSE_ARGS, scriptSurfaces, undeclaredScripts } from '../../scripts/contract/surface.js'

const RECORDED = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../contract/surface.json'), 'utf8')) as Pick<Surface, 'scripts'>

const SCRIPTS_WITH_FLAGS_IN_THE_GAP_REPORT = [
  'approve',
  'board',
  'bus:agent',
  'bus:bg',
  'bus:launch',
  'bus:netwatch',
  'bus:report',
  'bus:request',
  'bus:review',
  'bus:slot',
  'card',
  'card:measure',
  'checks:catalog',
  'checks:matrix',
  'ci:select',
  'contract:bump',
  'contract:update',
  'decisions:add',
  'done:check',
  'factory:start',
  'gate:window',
  'ghosts:cleanup',
  'ghosts:expect-sample',
  'ghosts:hash',
  'ghosts:launch',
  'ghosts:role',
  'ghosts:verdict',
  'ghosts:watch',
  'handoff:write',
  'intake',
  'miko',
  'miko:watch',
  'morse:predict',
  'owner:command',
  'release',
  'shard',
  'task:close',
  'task:start',
  'test:weights',
]

const STRICT_ENTRY = `import { parseArgs } from 'node:util'
const APPLY_FLAG = 'apply'
const { values } = parseArgs({ args: process.argv.slice(2), options: { card: { type: 'string' }, [APPLY_FLAG]: { type: 'boolean' } } })
if (values.card === undefined)
  process.exitCode = 2
`

const LOOSE_ENTRY = `const args = process.argv.slice(2)
const json = args.includes('--json')
console.log(\`usage: pnpm loose [--\${'tail'}]\`, json)
if (args.includes('--once'))
  process.exit(3)
`

const WITH_UNDECLARED_FLAG = LOOSE_ENTRY.replace('\'--once\'', '\'--once\') || args.includes(\'--since\'')

function tree(entries: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-surface-scripts-'))
  mkdirSync(path.join(root, 'scripts'))
  for (const [name, source] of Object.entries(entries))
    writeFileSync(path.join(root, 'scripts', `${name}.ts`), source)
  const scripts = Object.fromEntries(Object.keys(entries).map(name => [name, `node --import tsx scripts/${name}.ts`]))
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { ...scripts, build: 'tsup' }, scriptsOutsideTheHarness: {} }))
  return root
}

function declared(surface: ScriptSurface, change: Partial<ScriptSurface>): ScriptSurface {
  return { ...surface, ...change }
}

describe('the scripts section of contract/surface.json declares what every package.json script accepts', () => {
  it('declares every flag, json form, exit code and refusal the head\'s scripts read as', () => {
    expect(undeclaredScripts(RECORDED.scripts, scriptSurfaces())).toEqual([])
  })

  it('records flags for each of the 39 scripts the gap report names', () => {
    const flagless = SCRIPTS_WITH_FLAGS_IN_THE_GAP_REPORT.filter(name => (RECORDED.scripts[name]?.flags.length ?? 0) === 0)
    expect(SCRIPTS_WITH_FLAGS_IN_THE_GAP_REPORT).toHaveLength(39)
    expect(flagless).toEqual([])
  })

  it('reads parseArgs options, constants behind them, literal flags, template flags and exit codes from the entry', () => {
    const read = scriptSurfaces(tree({ strict: STRICT_ENTRY, loose: LOOSE_ENTRY }))
    expect(read).toEqual({
      build: { entries: [], flags: [], json: false, exits: [], unknownFlag: REFUSAL_NOT_READ },
      loose: { entries: ['scripts/loose.ts'], flags: ['json', 'once', 'tail'], json: true, exits: [3], unknownFlag: REFUSAL_NOT_READ },
      strict: { entries: ['scripts/strict.ts'], flags: ['apply', 'card'], json: false, exits: [2], unknownFlag: REFUSED_BY_STRICT_PARSE_ARGS },
    })
  })

  it('fails on a flag a script accepts that the section does not declare', () => {
    const recorded = scriptSurfaces(tree({ loose: LOOSE_ENTRY }))
    const head = scriptSurfaces(tree({ loose: WITH_UNDECLARED_FLAG }))
    expect(undeclaredScripts(recorded, head)).toEqual(['pnpm loose --since: the flag is not declared'])
  })

  it('fails on a json form, an exit code or a refusal the section does not declare', () => {
    const head = scriptSurfaces(tree({ loose: LOOSE_ENTRY }))
    const recorded = { ...head, loose: declared(head.loose, { flags: ['json', 'once', 'tail'], json: false, exits: [], unknownFlag: REFUSED_BY_STRICT_PARSE_ARGS }) }
    expect(undeclaredScripts(recorded, head)).toEqual([
      'pnpm loose --json: the json form is not declared',
      'pnpm loose: exit 3 is not declared',
      `pnpm loose --undeclared-flag-probe: the refusal of an unknown flag reads as ${REFUSAL_NOT_READ}, declared as ${REFUSED_BY_STRICT_PARSE_ARGS}`,
    ])
  })

  it('fails on a script the section does not declare at all', () => {
    const head = scriptSurfaces(tree({ loose: LOOSE_ENTRY }))
    const { loose: _, ...recorded } = head
    expect(undeclaredScripts(recorded, head)).toEqual(['pnpm loose: the script is not declared'])
  })
})
