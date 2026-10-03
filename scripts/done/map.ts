import { readJson } from './json.js'

export interface MapTest {
  file: string
  title: string
}

export interface MapWitness {
  witness: string
}

export interface MapRow {
  id: string
  code: string[]
  tests: Array<MapTest | MapWitness>
}

const ROW_KEYS = ['id', 'code', 'tests']
const TEST_KEYS = ['file', 'title', 'witness']

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

export function isWitnessEntry(entry: MapTest | MapWitness): entry is MapWitness {
  return 'witness' in entry
}

function isTest(value: unknown): value is MapTest | MapWitness {
  if (typeof value !== 'object' || value === null)
    return false
  const { file, title, witness } = value as Record<string, unknown>
  const isFileTest = typeof file === 'string' && typeof title === 'string' && witness === undefined
  const isWitness = typeof witness === 'string' && file === undefined && title === undefined
  return isFileTest || isWitness
}

function isRow(value: unknown): value is MapRow {
  if (typeof value !== 'object' || value === null)
    return false
  const { id, code, tests } = value as Record<string, unknown>
  return typeof id === 'string' && isStringArray(code) && Array.isArray(tests) && tests.every(isTest)
}

function unknownKey(value: unknown, known: string[]): string | undefined {
  return typeof value === 'object' && value !== null ? Object.keys(value).find(key => !known.includes(key)) : undefined
}

function unknownKeyIn(rows: unknown[]): string | undefined {
  for (const [at, row] of rows.entries()) {
    const key = unknownKey(row, ROW_KEYS)
    if (key !== undefined)
      return `requirements[${at}] has an unknown key "${key}"`
    const tests = (row as { tests?: unknown }).tests
    for (const [testAt, test] of (Array.isArray(tests) ? tests : []).entries()) {
      const testKey = unknownKey(test, TEST_KEYS)
      if (testKey !== undefined)
        return `requirements[${at}].tests[${testAt}] has an unknown key "${testKey}"`
    }
  }
  return undefined
}

export function readMap(mapPath: string): MapRow[] {
  const parsed: unknown = readJson(mapPath)
  const rows = typeof parsed === 'object' && parsed !== null ? (parsed as { requirements?: unknown }).requirements : undefined
  if (!Array.isArray(rows))
    throw new Error(`${mapPath} has no requirements array`)
  const unknown = unknownKeyIn(rows)
  if (unknown !== undefined)
    throw new Error(`${mapPath}: ${unknown}`)
  const bad = rows.findIndex(row => !isRow(row))
  if (bad >= 0)
    throw new Error(`${mapPath}: requirements[${bad}] is not { id, code, tests }`)
  const ids = (rows as MapRow[]).map(row => row.id)
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
  if (duplicate !== undefined)
    throw new Error(`${mapPath}: two rows have the id ${duplicate}`)
  return rows as MapRow[]
}
