import type { Relation } from '../src/model/schema.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { channelMap } from '../src/atlas/channels.js'
import { componentMap } from '../src/atlas/components.js'
import { discoverMechanics } from '../src/model/discovery.js'
import { MODEL_FILE, parseModel } from '../src/model/schema.js'

function repository(tree: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-file-channels-'))
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

const JOURNAL: Record<string, string> = {
  'src/journal/write.ts': [
    'import { appendFileSync } from \'node:fs\'',
    'import path from \'node:path\'',
    '',
    'export function record(dir: string, line: string): void {',
    '  appendFileSync(path.join(dir, \'ghosts.jsonl\'), line.concat(\'\\n\'))',
    '}',
    '',
  ].join('\n'),
  'src/board/read.ts': [
    'import { readFileSync } from \'node:fs\'',
    'import path from \'node:path\'',
    '',
    'export function lines(dir: string): string[] {',
    '  return readFileSync(path.join(dir, \'ghosts.jsonl\'), \'utf8\').split(\'\\n\')',
    '}',
    '',
  ].join('\n'),
  'src/label.ts': 'export function label(): string {\n  return \'ghosts.jsonl\'\n}\n',
  'src/cache.ts': [
    'import * as fs from \'node:fs\'',
    '',
    'export function touch(): string {',
    '  fs.writeFileSync(\'cache.json\', \'{}\')',
    '  return fs.readFileSync(\'cache.json\', \'utf8\')',
    '}',
    '',
  ].join('\n'),
}

function fileRelations(relations: Relation[]): Relation[] {
  return relations.filter(relation => relation.kind === 'writes' || relation.kind === 'reads')
}

describe('construct atlas: relations through files', () => {
  it('a fixture with one module writing a file and another reading it shows one file relation with both path:line', () => {
    const mechanics = discoverMechanics(repository(JOURNAL))
    expect(channelMap(mechanics.relations)).toEqual([
      { file: 'ghosts.jsonl', writer: 'src/journal/write.ts', writerAt: 'src/journal/write.ts:5', reader: 'src/board/read.ts', readerAt: 'src/board/read.ts:5' },
    ])
  })

  it('records the channel as a writes and a reads relation, each standing on its own path and line', () => {
    const mechanics = discoverMechanics(repository(JOURNAL))
    expect(fileRelations(mechanics.relations)).toEqual([
      { from: 'src/board/read.ts', to: 'src/journal/write.ts', kind: 'reads', specifier: 'ghosts.jsonl', status: 'found', source: { path: 'src/board/read.ts', line: 5 } },
      { from: 'src/journal/write.ts', to: 'src/board/read.ts', kind: 'writes', specifier: 'ghosts.jsonl', status: 'found', source: { path: 'src/journal/write.ts', line: 5 } },
    ])
    const document = JSON.stringify({ modelVersion: 6, facts: [], claims: [], hypotheses: [], mechanics })
    expect(fileRelations(parseModel(document, MODEL_FILE).mechanics!.relations)).toEqual(fileRelations(mechanics.relations))
  })

  it('a module that names a file without touching node:fs, or one that writes and reads only its own file, makes no channel', () => {
    const mechanics = discoverMechanics(repository(JOURNAL))
    expect(channelMap(mechanics.relations).map(channel => channel.file)).toEqual(['ghosts.jsonl'])
    expect(fileRelations(mechanics.relations).some(relation => relation.from === 'src/label.ts' || relation.from === 'src/cache.ts')).toBe(false)
  })

  it('a file named through an exported constant joins the channel at the line that imports it', () => {
    const mechanics = discoverMechanics(repository({
      'src/places.ts': 'export const JOURNAL = \'runs.jsonl\'\n',
      'src/a.ts': 'import { writeFileSync } from \'node:fs\'\nimport { JOURNAL } from \'./places.js\'\n\nwriteFileSync(JOURNAL, \'\')\n',
      'src/b.ts': 'import * as fs from \'node:fs\'\nimport { JOURNAL } from \'./places.js\'\n\nexport const text = fs.readFileSync(JOURNAL, \'utf8\')\n',
    }))
    expect(channelMap(mechanics.relations)).toEqual([
      { file: 'runs.jsonl', writer: 'src/a.ts', writerAt: 'src/a.ts:2', reader: 'src/b.ts', readerAt: 'src/b.ts:2' },
    ])
  })

  it('the code arrows do not count a file channel', () => {
    const mechanics = discoverMechanics(repository(JOURNAL))
    expect(componentMap(mechanics, [], 'journal').relations).toEqual([])
  })
})
