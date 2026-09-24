import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(REPO_ROOT, 'scripts/construct/contract-paths.mjs')

interface ContractPaths {
  manifestContractPaths: (manifest: unknown) => string[]
  claudeContractPaths: (text: string) => string[]
  contractPaths: (root: string) => string[]
}

const { claudeContractPaths, contractPaths, manifestContractPaths } = await import(pathToFileURL(SCRIPT).href) as ContractPaths

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function repository(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'contract-paths-'))
  dirs.push(dir)
  for (const [file, content] of Object.entries(files))
    writeFileSync(path.join(dir, file), content)
  return dir
}

describe('the contract paths the /implement skill passes to the ladder', () => {
  it('contain contract/surface.json for this repository, read from its CLAUDE.md', () => {
    expect(contractPaths(REPO_ROOT)).toContain('contract/surface.json')
  })

  it('take contracts.path and contracts.types from construct.json when contracts is non-null', () => {
    expect(manifestContractPaths({ contracts: { path: 'contracts/openapi.yaml', types: 'src/contracts/openapi.ts' } }))
      .toEqual(['contracts/openapi.yaml', 'src/contracts/openapi.ts'])
    expect(manifestContractPaths({ contracts: null })).toEqual([])
  })

  it('split the CLAUDE.md line on commas and trim each path', () => {
    expect(claudeContractPaths('# x\n\nContract paths: a.json , docs/b.yaml,\n')).toEqual(['a.json', 'docs/b.yaml'])
    expect(claudeContractPaths('# x\n\nno such line\n')).toEqual([])
  })

  it('join both sources without duplicates', () => {
    const dir = repository({
      'construct.json': JSON.stringify({ contracts: { path: 'contracts/openapi.yaml', types: 'src/contracts/openapi.ts' } }),
      'CLAUDE.md': 'Contract paths: contracts/openapi.yaml, contract/surface.json\n',
    })
    expect(contractPaths(dir)).toEqual(['contracts/openapi.yaml', 'src/contracts/openapi.ts', 'contract/surface.json'])
  })

  it('are empty when neither construct.json nor CLAUDE.md names one, as in an attached repository', () => {
    expect(contractPaths(repository({ 'CLAUDE.md': '# attached\n' }))).toEqual([])
    expect(contractPaths(repository({}))).toEqual([])
  })
})
