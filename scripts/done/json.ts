import { readFileSync } from 'node:fs'

export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  catch {
    throw new Error(`${file} is not readable JSON`)
  }
}
