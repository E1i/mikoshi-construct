import { readFileSync } from 'node:fs'

const DESIGN_LINE = /^- (D\d+)\. /

export function readRequirements(argsPath: string): string[] {
  const parsed: unknown = readJson(argsPath)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`${argsPath} is not a JSON object`)
  const { acceptance, design } = parsed as { acceptance?: unknown, design?: unknown }
  if (!Array.isArray(acceptance) || acceptance.length === 0)
    throw new Error(`${argsPath} has no acceptance item`)
  if (typeof design !== 'string')
    throw new Error(`${argsPath} has a design that is not a string`)
  const designIds = design.split('\n').flatMap(line => DESIGN_LINE.exec(line)?.[1] ?? [])
  return [...acceptance.map((_, index) => `A${index + 1}`), ...designIds]
}

export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  catch {
    throw new Error(`${file} is not readable JSON`)
  }
}
