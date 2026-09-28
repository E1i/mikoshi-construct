import type { ChangedFile } from './rules.js'
import { classify, MorseRefusal, RULES } from './rules.js'

interface PrRecord {
  number: number
  title: string
  files: ChangedFile[]
  fact: boolean | null
  factSource: string
}

const REQUIRED_KEYS = ['number', 'title', 'files', 'fact', 'factSource']

interface Bucket {
  fact: number
  noFact: number
}

export interface BacktestResult {
  rows: number
  excluded: number[]
  matrix: { ladder: Bucket, cheap: Bucket }
  byRule: Record<string, Bucket>
  missed: number[]
}

function parseLine(line: string, lineNumber: number): PrRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  }
  catch {
    throw new MorseRefusal(`line ${lineNumber}: not valid JSON`)
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new MorseRefusal(`line ${lineNumber}: not a JSON object`)

  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record)

  const missingKey = REQUIRED_KEYS.find(key => !(key in record))
  if (missingKey !== undefined)
    throw new MorseRefusal(`line ${lineNumber}: missing key "${missingKey}"`)

  const unknownKey = keys.find(key => !REQUIRED_KEYS.includes(key))
  if (unknownKey !== undefined)
    throw new MorseRefusal(`line ${lineNumber}: unknown key "${unknownKey}"`)

  const fact = record.fact
  if (fact !== true && fact !== false && fact !== null)
    throw new MorseRefusal(`line ${lineNumber}: fact must be true, false or null (got ${JSON.stringify(fact)})`)

  return {
    number: record.number as number,
    title: record.title as string,
    files: record.files as ChangedFile[],
    fact,
    factSource: record.factSource as string,
  }
}

function emptyBucket(): Bucket {
  return { fact: 0, noFact: 0 }
}

export function runBacktest(text: string): BacktestResult {
  const rawLines = text.split('\n')
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '')
    rawLines.pop()

  const records = rawLines.map((line, index) => parseLine(line, index + 1))

  const excluded: number[] = []
  const missed: number[] = []
  const matrix = { ladder: emptyBucket(), cheap: emptyBucket() }
  const byRule: Record<string, Bucket> = {}
  for (const rule of RULES)
    byRule[rule.id] = emptyBucket()

  for (const record of records) {
    if (record.fact === null) {
      excluded.push(record.number)
      continue
    }

    const prediction = classify(record.files)
    const bucket = matrix[prediction.verdict]
    const ruleBucket = byRule[prediction.rule]
    if (record.fact) {
      bucket.fact += 1
      ruleBucket.fact += 1
    }
    else {
      bucket.noFact += 1
      ruleBucket.noFact += 1
    }

    if (prediction.verdict === 'cheap' && record.fact === true)
      missed.push(record.number)
  }

  return { rows: records.length, excluded, matrix, byRule, missed }
}
