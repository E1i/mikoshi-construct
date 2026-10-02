import { readFileSync } from 'node:fs'

const DESIGN_LINE = /^- (D\d+)\. /

export interface BriefWitness {
  criterion: string
  command: string
}

export interface WitnessDigest {
  criterion: string
  sha256: string
}

export interface Brief {
  requirements: string[]
  witnesses: BriefWitness[]
  witnessDigests: WitnessDigest[]
}

function entriesOf<T>(argsPath: string, field: string, value: unknown, keys: Array<keyof T & string>): T[] {
  if (value === undefined)
    return []
  const isEntry = (item: unknown): item is T => typeof item === 'object' && item !== null && keys.every(key => typeof (item as Record<string, unknown>)[key] === 'string')
  if (!Array.isArray(value) || !value.every(isEntry))
    throw new Error(`${argsPath} has ${field} that are not [{ ${keys.join(', ')} }]`)
  return value
}

export function readBrief(argsPath: string): Brief {
  const parsed: unknown = readJson(argsPath)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`${argsPath} is not a JSON object`)
  const { acceptance, design, witnesses, witnessDigests } = parsed as { acceptance?: unknown, design?: unknown, witnesses?: unknown, witnessDigests?: unknown }
  if (!Array.isArray(acceptance) || acceptance.length === 0)
    throw new Error(`${argsPath} has no acceptance item`)
  if (typeof design !== 'string')
    throw new Error(`${argsPath} has a design that is not a string`)
  const designIds = design.split('\n').flatMap(line => DESIGN_LINE.exec(line)?.[1] ?? [])
  return {
    requirements: [...acceptance.map((_, index) => `A${index + 1}`), ...designIds],
    witnesses: entriesOf<BriefWitness>(argsPath, 'witnesses', witnesses, ['criterion', 'command']),
    witnessDigests: entriesOf<WitnessDigest>(argsPath, 'witnessDigests', witnessDigests, ['criterion', 'sha256']),
  }
}

export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  catch {
    throw new Error(`${file} is not readable JSON`)
  }
}
