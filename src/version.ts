import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function readVersion(): string {
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const parsed = JSON.parse(readFileSync(path.resolve(HERE, candidate), 'utf8')) as { name?: string, version?: string }
      if (parsed.name === 'mikoshi-construct' && parsed.version != null)
        return parsed.version
    }
    catch {}
  }
  return '0.0.0'
}

export const VERSION = readVersion()
