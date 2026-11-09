import type { Factory } from '../../scripts/contract/factory.js'
import type { FileSources, HomeFile } from '../../scripts/contract/factory/files.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { filesSection, HOME_FILES } from '../../scripts/contract/factory/files.js'
import { parsedFiles, SCANNED_TREES } from '../../scripts/contract/factory/walk.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const RECORDED: Factory = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract', 'factory.json'), 'utf8')) as Factory
const NO_SOURCES: FileSources = { events: new Set(), tables: new Set() }
const LANE_SOURCES: FileSources = { events: new Set(['lane.assigned']), tables: new Set(['decisions']) }
const LANE_VIEW = '~/.construct/parking/*/lane.json'
const DECISIONS_VIEW = '~/.construct/owner-decisions.md'

const roots: string[] = []

afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true })
})

function tree(modules: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'contract-files-'))
  roots.push(root)
  for (const scanned of SCANNED_TREES)
    mkdirSync(path.join(root, scanned), { recursive: true })
  for (const [file, text] of Object.entries(modules)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

function writerOf(file: string): string {
  return `import { writeFileSync } from 'node:fs'\nimport path from 'node:path'\n\nexport function save(): void {\n  writeFileSync(path.join('.construct', '${file}'), '{}')\n}\n`
}

function makerOf(directory: string): string {
  return `import { mkdirSync } from 'node:fs'\nimport path from 'node:path'\n\nexport function make(): void {\n  mkdirSync(path.join('.construct', '${directory}'), { recursive: true })\n}\n`
}

const RECORD: HomeFile = { path: '.construct/record.json', names: ['record.json'], source: { kind: 'owner' } }
const RECORD_READ: HomeFile = { ...RECORD, owner: 'src/reader.ts' }
const CACHE: HomeFile = { path: '.construct/cache', names: ['.construct/cache'], source: { kind: 'owner' } }
const THINGS: HomeFile = { path: '~/.construct/bus.db#things', names: [], source: { kind: 'owner' } }
const READER = `export const RECORD_FILE = 'record.json'\n`
const TABLE_WRITER = `export const CREATE = 'CREATE TABLE IF NOT EXISTS things (id INTEGER)'\nexport const ADD = 'INSERT INTO things (id) VALUES (?)'\n`
const TABLE_READER = `export const ALL = 'SELECT id FROM things'\n`

describe('the files section of contract/factory.json', () => {
  it('a file in the home directory or under .construct with no entry in contract/factory.json fails the check', () => {
    const files = parsedFiles(tree({ 'scripts/one.ts': writerOf('stray.json') }))
    expect(() => filesSection(files, NO_SOURCES, [RECORD])).toThrow(/\.construct\/stray\.json \(scripts\/one\.ts\)/)
    expect(() => filesSection(files, NO_SOURCES, [RECORD])).toThrow(/has no entry/)
  })

  it('a file with two writer modules fails the check', () => {
    const files = parsedFiles(tree({ 'scripts/one.ts': writerOf('record.json'), 'scripts/two.ts': writerOf('record.json') }))
    expect(() => filesSection(files, NO_SOURCES, [RECORD])).toThrow(/2 writer modules \(scripts\/one\.ts, scripts\/two\.ts\)/)
  })

  it('a file with one writer module is owned by it', () => {
    const files = parsedFiles(tree({ 'scripts/one.ts': writerOf('record.json'), 'src/reader.ts': `export const RECORD_FILE = 'record.json'\n` }))
    expect(filesSection(files, NO_SOURCES, [RECORD]).entries[RECORD.path]).toMatchObject({ owner: 'scripts/one.ts', source: 'owner', derived: false, writers: ['scripts/one.ts'] })
  })

  it('a derived view is owned by the one writer of its source, whatever renders it', () => {
    const view: HomeFile = { path: '.construct/view.json', names: ['view.json'], source: { kind: 'event', name: 'lane.assigned' } }
    const emitter = `export const LANE_ASSIGNED = 'lane.assigned'\nexport function assign(append: (event: { type: string }) => void): void {\n  append({ type: LANE_ASSIGNED })\n}\n`
    const files = parsedFiles(tree({ 'scripts/emit.ts': emitter, 'scripts/one.ts': writerOf('view.json'), 'scripts/two.ts': writerOf('view.json') }))
    expect(filesSection(files, LANE_SOURCES, [view]).entries[view.path]).toMatchObject({ owner: 'scripts/emit.ts', source: 'event:lane.assigned', derived: true, writers: ['scripts/one.ts', 'scripts/two.ts'] })
  })

  it('a derived view whose source has two writers fails the check', () => {
    const view: HomeFile = { path: '.construct/view.md', names: ['view.md'], source: { kind: 'table', name: 'decisions' } }
    const insert = `export const ADD = 'INSERT INTO decisions (text) VALUES (?)'\n`
    const files = parsedFiles(tree({ 'scripts/one.ts': insert, 'scripts/two.ts': insert, 'scripts/render.ts': writerOf('view.md') }))
    expect(() => filesSection(files, LANE_SOURCES, [view])).toThrow(/table decisions, the source of \.construct\/view\.md, has 2 writer modules/)
  })

  it('a derived view of a source the bus section does not hold fails the check', () => {
    const view: HomeFile = { path: '.construct/view.json', names: ['view.json'], source: { kind: 'event', name: 'lane.assigned' } }
    const files = parsedFiles(tree({ 'scripts/emit.ts': `export const E = { type: 'lane.assigned' }\n`, 'scripts/one.ts': writerOf('view.json') }))
    expect(() => filesSection(files, NO_SOURCES, [view])).toThrow(/which the bus section does not hold/)
  })

  it('a declared owner that does not name the file fails the check', () => {
    const files = parsedFiles(tree({ 'scripts/one.ts': writerOf('record.json') }))
    expect(() => filesSection(files, NO_SOURCES, [{ ...RECORD, owner: 'scripts/other.ts' }])).toThrow(/declared owned by scripts\/other\.ts, which does not name it/)
  })

  it('a declared owner that is not the one writer of the file fails the check', () => {
    const files = parsedFiles(tree({ 'scripts/one.ts': writerOf('record.json'), 'src/reader.ts': READER }))
    expect(() => filesSection(files, NO_SOURCES, [{ ...RECORD, owner: 'src/reader.ts' }])).toThrow(/declared owned by src\/reader\.ts and written by scripts\/one\.ts/)
  })

  it('a declared owner that names a file nobody writes owns it', () => {
    const files = parsedFiles(tree({ 'src/reader.ts': READER, 'src/other.ts': READER }))
    expect(filesSection(files, NO_SOURCES, [{ ...RECORD, owner: 'src/reader.ts' }]).entries[RECORD.path]).toMatchObject({ owner: 'src/reader.ts', writers: [] })
  })

  it('an entry no module names is stale and fails the check', () => {
    const files = parsedFiles(tree({ 'scripts/one.ts': `export const NOTHING = 1\n` }))
    expect(() => filesSection(files, NO_SOURCES, [RECORD])).toThrow(/\.construct\/record\.json is named in no module under record\.json; the entry is stale/)
  })

  it('a file no module writes and two modules name fails the check until one is declared its owner', () => {
    const files = parsedFiles(tree({ 'src/reader.ts': READER, 'src/other.ts': READER }))
    expect(() => filesSection(files, NO_SOURCES, [RECORD])).toThrow(/has no single writer and is named in src\/other\.ts, src\/reader\.ts; declare which of them owns it/)
  })

  it('a directory may have several writer modules and is owned by the one declared', () => {
    const files = parsedFiles(tree({ 'scripts/one.ts': makerOf('cache'), 'scripts/two.ts': makerOf('cache') }))
    const entry = filesSection(files, NO_SOURCES, [{ ...CACHE, owner: 'scripts/two.ts' }]).entries[CACHE.path]
    expect(entry).toMatchObject({ owner: 'scripts/two.ts', directory: true, writers: ['scripts/one.ts', 'scripts/two.ts'] })
  })

  it('a directory with one module naming it is owned by that module, whoever writes it', () => {
    const files = parsedFiles(tree({ 'scripts/one.ts': makerOf('cache') }))
    expect(filesSection(files, NO_SOURCES, [CACHE]).entries[CACHE.path]).toMatchObject({ owner: 'scripts/one.ts', directory: true })
  })

  it('a table is owned by the one module that writes its rows', () => {
    const files = parsedFiles(tree({ 'scripts/store.ts': TABLE_WRITER, 'scripts/read.ts': TABLE_READER }))
    expect(filesSection(files, NO_SOURCES, [THINGS]).entries[THINGS.path]).toMatchObject({ owner: 'scripts/store.ts', directory: false, writers: ['scripts/store.ts'], namedIn: ['scripts/read.ts', 'scripts/store.ts'] })
  })

  it('a table with two writer modules fails the check', () => {
    const files = parsedFiles(tree({ 'scripts/store.ts': TABLE_WRITER, 'scripts/other.ts': TABLE_WRITER }))
    expect(() => filesSection(files, NO_SOURCES, [THINGS])).toThrow(/~\/\.construct\/bus\.db#things has 2 writer modules/)
  })

  it('a table with no entry fails the check unless the bus section holds it', () => {
    const files = parsedFiles(tree({ 'scripts/store.ts': TABLE_WRITER }))
    expect(() => filesSection(files, NO_SOURCES, [RECORD_READ])).toThrow(/#things \(scripts\/store\.ts\)/)
    expect(() => filesSection(files, NO_SOURCES, [{ ...THINGS, path: '~/.construct/bus.db#other' }])).toThrow(/#things \(scripts\/store\.ts\)/)
    const held: FileSources = { events: new Set(), tables: new Set(['things']) }
    expect(Object.keys(filesSection(parsedFiles(tree({ 'scripts/store.ts': TABLE_WRITER, 'src/reader.ts': READER })), held, [RECORD_READ]).entries)).toEqual([RECORD.path])
  })

  it('records lane and owner-decisions as derived views of their one source', () => {
    expect(RECORDED.files.entries[LANE_VIEW]).toMatchObject({ derived: true, source: 'event:lane.assigned' })
    expect(RECORDED.files.entries[DECISIONS_VIEW]).toMatchObject({ derived: true, source: 'table:decisions' })
  })

  it('records every home file with its owner and its source', () => {
    expect(Object.keys(RECORDED.files.entries).sort()).toEqual(HOME_FILES.map(entry => entry.path).sort())
    for (const entry of Object.values(RECORDED.files.entries).filter(({ derived }) => !derived))
      expect(entry.namedIn).toContain(entry.owner)
  })
})
