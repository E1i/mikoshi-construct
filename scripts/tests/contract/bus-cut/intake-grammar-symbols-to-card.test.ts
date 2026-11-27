import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const ADMIT = 'src/commands/intake/admit.ts'
const CARD_READINGS = 'scripts/core/card-readings.ts'
const TASKS = 'scripts/core/tasks.ts'
const HEARTBEAT = 'scripts/supervisor/heartbeat.ts'
const DECLARATIONS = 'declarations/modules'
const MOVED_FROM_ADMIT = ['pathsNamedOutside', 'ADMIT_SOURCE', 'isLaneName', 'LANE_FILE'] as const
const BUS_CARD_STATES = 'busCardStates'
const LAST_HEARTBEAT = 'lastHeartbeat'
const LANE_FILES = ['scripts/intake/lane-json.ts', 'scripts/intake/parking-reads.ts'] as const
const WITNESS_FIELDS_BACKFILL = 'scripts/intake/witness-fields-backfill.ts'
const SESSION_DECLARATION = 'session.json'
const CARD_DECLARATION = /^card.*\.json$/

interface ModuleDeclaration {
  module: string
  paths: string[]
}

function sourceOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

function declares(source: string, symbol: string): boolean {
  return new RegExp(`^(?:export )?(?:async )?(?:function|interface|const|let|class|type) ${symbol}\\b`, 'm').test(source)
}

function declarationOf(file: string): ModuleDeclaration {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, DECLARATIONS, file), 'utf8')) as ModuleDeclaration
}

function cardDeclarations(): ModuleDeclaration[] {
  return readdirSync(path.join(REPO_ROOT, DECLARATIONS)).filter(file => CARD_DECLARATION.test(file)).map(declarationOf)
}

describe('the intake grammar symbols are declared outside admit, busCardStates lives in card-readings and the lane files are declared in card', () => {
  it('admit declares none of the moved grammar symbols', () => {
    const admit = sourceOf(ADMIT)
    expect(MOVED_FROM_ADMIT.filter(symbol => declares(admit, symbol))).toEqual([])
  })

  it('card-readings declares busCardStates and tasks does not name it', () => {
    expect(declares(sourceOf(CARD_READINGS), BUS_CARD_STATES)).toBe(true)
    expect(sourceOf(TASKS)).not.toContain(BUS_CARD_STATES)
  })

  it('heartbeat does not declare lastHeartbeat', () => {
    expect(declares(sourceOf(HEARTBEAT), LAST_HEARTBEAT)).toBe(false)
  })

  it('a card declaration lists lane-json and parking-reads, and session alone lists witness-fields-backfill', () => {
    const cardPaths = cardDeclarations().flatMap(declaration => declaration.paths)
    expect(LANE_FILES.filter(file => !cardPaths.includes(file))).toEqual([])
    expect(declarationOf(SESSION_DECLARATION).paths).toContain(WITNESS_FIELDS_BACKFILL)
    expect(cardPaths).not.toContain(WITNESS_FIELDS_BACKFILL)
  })
})
