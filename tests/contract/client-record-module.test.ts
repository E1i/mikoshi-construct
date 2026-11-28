import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLIENT_RECORD = 'src/client-record.ts'
const MANIFEST = 'src/manifest.ts'
const CLIENT_PORT = 'scripts/ports/client/index.ts'
const MOVED_SYMBOLS = ['ClientRecord', 'ClientRole', 'clientIdFor', 'clientModelOf', 'CLIENT_ROLES'] as const

function sourceOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

function declares(source: string, symbol: string): boolean {
  return new RegExp(`^export (?:const|type|interface|function) ${symbol}\\b`, 'm').test(source)
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1]!)
}

function importsFrom(source: string, target: string): string[] {
  return [...source.matchAll(/^import\s(?:type\s)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm)]
    .filter(match => match[2]!.endsWith(target))
    .flatMap(match => match[1]!.split(',').map(name => name.trim()).filter(name => name !== ''))
}

describe('the client record symbols live in the product module and the client port reads them from there', () => {
  it('declares every moved symbol in src/client-record.ts and none in src/manifest.ts', () => {
    const record = sourceOf(CLIENT_RECORD)
    const manifest = sourceOf(MANIFEST)
    for (const symbol of MOVED_SYMBOLS) {
      expect(declares(record, symbol), `${symbol} in ${CLIENT_RECORD}`).toBe(true)
      expect(declares(manifest, symbol), `${symbol} in ${MANIFEST}`).toBe(false)
    }
  })

  it('keeps src/client-record.ts free of any import, so it reaches nothing under scripts/', () => {
    expect(importSpecifiers(sourceOf(CLIENT_RECORD))).toEqual([])
  })

  it('has src/manifest.ts read the record from src/client-record.ts', () => {
    expect(importsFrom(sourceOf(MANIFEST), '/client-record.js').length).toBeGreaterThan(0)
  })

  it('gives the client port no import of a moved symbol from src/manifest.ts', () => {
    const fromManifest = importsFrom(sourceOf(CLIENT_PORT), '/manifest.js')
    for (const symbol of MOVED_SYMBOLS)
      expect(fromManifest).not.toContain(symbol)
  })
})
