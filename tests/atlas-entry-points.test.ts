import type { Relation } from '../src/model/schema.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { componentMap } from '../src/atlas/components.js'
import { entryMap } from '../src/atlas/entries.js'
import { atlasScript } from '../src/atlas/map.js'
import { discoverMechanics } from '../src/model/discovery.js'
import { MODEL_FILE, parseModel } from '../src/model/schema.js'
import { deriveModelState } from '../src/model/state.js'

function repository(tree: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-entry-points-'))
  for (const [file, content] of Object.entries(tree)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), content)
  }
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'base')
  return dir
}

const ENTRIES: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: 'shop', scripts: { board: 'tsx scripts/board.ts --once', test: 'vitest run', ci: 'pnpm run test && node ./scripts/check.mjs' } }, null, 2)}\n`,
  '.github/workflows/ci.yml': [
    'name: ci',
    'on: push',
    'jobs:',
    '  quality:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - name: Check',
    '        run: node scripts/check.mjs',
    '      - run: |',
    '          echo start',
    '          tsx scripts/board.ts',
    '',
  ].join('\n'),
  '.claude/settings.json': [
    '{',
    '  "hooks": {',
    '    "PreToolUse": [',
    '      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node \\"$CLAUDE_PROJECT_DIR/.claude/hooks/guard.mjs\\"" }] }',
    '    ],',
    '    "Stop": [{ "hooks": [{ "type": "command", "command": "node .claude/hooks/journal.mjs" }] }]',
    '  }',
    '}',
    '',
  ].join('\n'),
  '.claude/hooks/guard.mjs': 'export const guard = 1\n',
  '.claude/hooks/journal.mjs': 'export const journal = 1\n',
  'scripts/board.ts': 'import { list } from \'./lib.js\'\n\nlist()\n',
  'scripts/lib.ts': 'export function list(): void {}\n',
  'scripts/check.mjs': 'console.log(1)\n',
}

function runs(relations: Relation[]): Relation[] {
  return relations.filter(relation => relation.kind === 'runs')
}

describe('construct atlas: entry points come from the repository\'s own configs', () => {
  it('package.json scripts, workflow steps and hooks of a fixture repository appear as entry nodes linked to what they run', () => {
    const mechanics = discoverMechanics(repository(ENTRIES))
    expect(entryMap(mechanics.relations).entries).toEqual([
      { id: 'e:.claude/settings.json#PreToolUse Bash', kind: 'hook', name: 'PreToolUse Bash', source: '.claude/settings.json', at: '.claude/settings.json:4', runs: ['.claude/hooks/guard.mjs'] },
      { id: 'e:.claude/settings.json#Stop', kind: 'hook', name: 'Stop', source: '.claude/settings.json', at: '.claude/settings.json:6', runs: ['.claude/hooks/journal.mjs'] },
      { id: 'e:.github/workflows/ci.yml#quality › Check', kind: 'step', name: 'quality › Check', source: '.github/workflows/ci.yml', at: '.github/workflows/ci.yml:9', runs: ['scripts/check.mjs'] },
      { id: 'e:.github/workflows/ci.yml#quality › step 3', kind: 'step', name: 'quality › step 3', source: '.github/workflows/ci.yml', at: '.github/workflows/ci.yml:12', runs: ['scripts/board.ts'] },
      { id: 'e:package.json#board', kind: 'script', name: 'board', source: 'package.json', at: 'package.json:4', runs: ['scripts/board.ts'] },
      { id: 'e:package.json#ci', kind: 'script', name: 'ci', source: 'package.json', at: 'package.json:6', runs: ['scripts/check.mjs'] },
    ])
    expect(entryMap(mechanics.relations).sources.map(source => [source.id, source.kind, source.entries.length])).toEqual([
      ['s:.claude/settings.json', 'hook', 2],
      ['s:.github/workflows/ci.yml', 'step', 2],
      ['s:package.json', 'script', 2],
    ])
  })

  it('an entry whose command names no tracked file is not recorded, as an import of a package is not', () => {
    const mechanics = discoverMechanics(repository(ENTRIES))
    expect(runs(mechanics.relations).filter(relation => relation.specifier === 'test' || relation.status !== 'found')).toEqual([])
  })

  it('the runs relations survive a write and a parse of the Engram', () => {
    const mechanics = discoverMechanics(repository(ENTRIES))
    const document = JSON.stringify({ modelVersion: 6, facts: [], claims: [], hypotheses: [], mechanics })
    expect(runs(parseModel(document, MODEL_FILE).mechanics!.relations)).toEqual(runs(mechanics.relations))
  })

  it('a module reached only from an entry point is run by it on the page, and the code arrows do not count entries', () => {
    const mechanics = discoverMechanics(repository(ENTRIES))
    expect(componentMap(mechanics, [], 'shop').relations.map(relation => `${relation.from} → ${relation.to}`)).toEqual(['scripts/board.ts → scripts/lib.ts', 'scripts/board.ts → scripts/lib.ts'])
    const model = parseModel(JSON.stringify({ modelVersion: 6, facts: [], claims: [], hypotheses: [], mechanics }), MODEL_FILE)
    const script = atlasScript({ projectName: 'shop', model, states: deriveModelState(model, tmpdir()), mechanics: model.mechanics }, '')!
    const data = JSON.parse(/const DATA = (.*);\n/.exec(script)![1]!) as { files: string[], entries: Array<{ name: string, runs: number[] }> }
    const runBy = (file: string): string[] => data.entries.filter(entry => entry.runs.includes(data.files.indexOf(file))).map(entry => entry.name)
    expect(runBy('scripts/check.mjs')).toEqual(['quality › Check', 'ci'])
    expect(runBy('scripts/lib.ts')).toEqual([])
  })

  it('only a `- ` item of a job\'s steps list is a step: a matrix include is not, and a list nested in a step keeps the step\'s run', () => {
    const mechanics = discoverMechanics(repository({
      '.github/workflows/matrix.yml': [
        'name: matrix',
        'on: push',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    strategy:',
        '      matrix:',
        '        include:',
        '          - os: ubuntu-latest',
        '          - os: macos-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - name: Check',
        '        run: node scripts/check.mjs',
        '      - run: tsx scripts/board.ts',
        '  nested:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Lists first',
        '        with:',
        '          list:',
        '            - a: b',
        '        run: node scripts/check.mjs',
        '',
      ].join('\n'),
      'scripts/board.ts': 'export const board = 1\n',
      'scripts/check.mjs': 'console.log(1)\n',
    }))
    expect(entryMap(mechanics.relations).entries.map(entry => [entry.name, entry.at, entry.runs])).toEqual([
      ['build › Check', '.github/workflows/matrix.yml:14', ['scripts/check.mjs']],
      ['build › step 3', '.github/workflows/matrix.yml:15', ['scripts/board.ts']],
      ['nested › Lists first', '.github/workflows/matrix.yml:23', ['scripts/check.mjs']],
    ])
  })

  it('a workflow without a jobs block, a settings file without hooks and a manifest without scripts declare no entry', () => {
    const mechanics = discoverMechanics(repository({
      'package.json': '{ "name": "bare" }\n',
      '.github/workflows/empty.yml': 'name: empty\non: push\n',
      '.claude/settings.json': '{ "permissions": {} }\n',
      'src/a.ts': 'export const a = 1\n',
    }))
    expect(runs(mechanics.relations)).toEqual([])
  })
})
