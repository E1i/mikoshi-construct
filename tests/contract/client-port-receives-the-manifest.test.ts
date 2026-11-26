import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const CLIENT_INDEX = path.join(ROOT, 'scripts', 'ports', 'client', 'index.ts')
const CLIENT_CONTRACT = path.join(ROOT, 'scripts', 'ports', 'client', 'contract.ts')
const MANIFEST = path.join(ROOT, 'src', 'manifest.ts')
const FORBIDDEN_SPECIFIERS = [/src\/manifest\.js$/, /ports\/shift-settings\.js$/]
const CLIENT_RECORD_SYMBOLS = ['ClientRecord', 'ClientRole', 'clientIdFor', 'clientModelOf', 'CLIENT_ROLES']

function importSpecifiersOf(source: string): string[] {
  return [...source.matchAll(/^(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map(match => match[1]!)
}

function declares(source: string, symbol: string): boolean {
  return new RegExp(`^export (?:const|function|type|interface) ${symbol}\\b`, 'm').test(source)
}

describe('the client port receives the manifest and the shift settings from its builder', () => {
  it('the client port imports neither the manifest nor the shift settings', () => {
    const specifiers = importSpecifiersOf(readFileSync(CLIENT_INDEX, 'utf8'))
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter(specifier => FORBIDDEN_SPECIFIERS.some(forbidden => forbidden.test(specifier)))).toEqual([])
  })

  it('the client contract declares the client record symbols', () => {
    const contract = readFileSync(CLIENT_CONTRACT, 'utf8')
    expect(CLIENT_RECORD_SYMBOLS.filter(symbol => !declares(contract, symbol))).toEqual([])
    const manifest = readFileSync(MANIFEST, 'utf8')
    expect(CLIENT_RECORD_SYMBOLS.filter(symbol => declares(manifest, symbol))).toEqual([])
  })
})
