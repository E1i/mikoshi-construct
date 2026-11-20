import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_BLOCKS } from '../../../../src/card/grammar.js'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import { openBus } from '../../../core/db.js'
import { openComposedBus } from '../../../supervisor/composition.js'

const DB = 'scripts/core/db.ts'
const GRAMMAR = 'src/card/grammar.ts'
const CARD_LINE = '#2113 cut-bus-card-sql-function [implement/construct/M/cheap/auto] · depends — · blocks #2114 #2115'
const NOT_A_CARD = 'not a card line'

const opened: DatabaseSync[] = []
const dirs: string[] = []

function busFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bus-card-sql-'))
  dirs.push(dir)
  return path.join(dir, 'bus.db')
}

function blocksOf(db: DatabaseSync, line: string | null): unknown {
  return (db.prepare(`SELECT ${CARD_BLOCKS}(?) AS blocks`).get(line) as { blocks: unknown }).blocks
}

afterEach(() => {
  for (const db of opened.splice(0))
    db.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('the bus opens the database and the card owner registers its own SQL function', () => {
  it('repositoryReport() holds no import scripts/core/db.ts -> src/card/grammar.ts', () => {
    const { graph } = repositoryReport()
    expect(graph.imports.filter(({ from, to }) => from === DB && to === GRAMMAR)).toEqual([])
  })

  it('a bus opened by the composition answers card_blocks', () => {
    const db = openComposedBus(busFile())
    opened.push(db)
    expect(JSON.parse(String(blocksOf(db, CARD_LINE)))).toEqual([2114, 2115])
    expect(blocksOf(db, NOT_A_CARD)).toBeNull()
    expect(blocksOf(db, null)).toBeNull()
  })

  it('a bare bus knows no card grammar', () => {
    const db = openBus(busFile())
    opened.push(db)
    expect(() => blocksOf(db, CARD_LINE)).toThrow(/no such function/)
  })
})
