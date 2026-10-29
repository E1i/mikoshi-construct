import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../..')
const DELETED = ['scripts/bus/backfill.ts', 'scripts/bus/node-equivalence.ts', 'scripts/lanes/migrate.ts']
const KEPT_FOR_THEIR_IMPORTERS = ['scripts/nodes/close/task-merged.ts', 'scripts/nodes/launch/launch-withdraw.ts']
const RELATIVE_IMPORT = /\bfrom '(\.{1,2}\/[^']+)\.js'/g

function tracked(...paths: string[]): string[] {
  return execFileSync('git', ['-C', root, 'ls-files', '--', ...paths], { encoding: 'utf8' }).split('\n').filter(file => file !== '' && existsSync(path.join(root, file)))
}

function importsOf(file: string): string[] {
  const text = readFileSync(path.join(root, file), 'utf8')
  return [...text.matchAll(RELATIVE_IMPORT)].map(match => path.posix.join(path.posix.dirname(file), `${match[1]}.ts`))
}

function importersOf(target: string, files: string[]): string[] {
  return files.filter(file => importsOf(file).includes(target))
}

function entriesOf(target: string): string[] {
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts as Record<string, string>
  return Object.entries(scripts).filter(([, command]) => command.includes(target)).map(([name]) => name)
}

describe('the dead modules of S5d', () => {
  const sources = tracked('*.ts', '*.mts', '*.mjs')

  it('task-merged and the one-off migrations have no importer and no entry', () => {
    expect(DELETED.filter(file => existsSync(path.join(root, file)))).toEqual([])
    expect(DELETED.flatMap(file => importersOf(file, sources))).toEqual([])
    expect(DELETED.flatMap(entriesOf)).toEqual([])
  })

  it('each dead module that stays is still imported outside the tests', () => {
    const product = sources.filter(file => !file.startsWith('scripts/tests/') && !file.startsWith('tests/'))
    expect(KEPT_FOR_THEIR_IMPORTERS.filter(file => importersOf(file, product).length === 0)).toEqual([])
  })
})
