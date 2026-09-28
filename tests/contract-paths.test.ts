import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(REPO_ROOT, 'scripts/construct/contract-paths.mjs')

interface ContractPaths {
  manifestContractPaths: (manifest: unknown) => string[]
  agentsContractPaths: (agentsText: string | null, claudeText: string | null) => string[]
  contractPaths: (root: string) => string[]
}

const { agentsContractPaths, contractPaths, manifestContractPaths } = await import(pathToFileURL(SCRIPT).href) as ContractPaths

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
  it('contain contract/surface.json for this repository, read from its AGENTS.md', () => {
    expect(contractPaths(REPO_ROOT)).toContain('contract/surface.json')
  })

  it('take contracts.path and contracts.types from construct.json when contracts is non-null', () => {
    expect(manifestContractPaths({ contracts: { path: 'contracts/openapi.yaml', types: 'src/contracts/openapi.ts' } }))
      .toEqual(['contracts/openapi.yaml', 'src/contracts/openapi.ts'])
    expect(manifestContractPaths({ contracts: null })).toEqual([])
  })

  it('reads Contract paths from AGENTS.md', () => {
    expect(agentsContractPaths('# x\n\nContract paths: a.json , docs/b.yaml,\n', null)).toEqual(['a.json', 'docs/b.yaml'])
    expect(agentsContractPaths('# x\n\nno such line\n', null)).toEqual([])
  })

  it('refuses a Contract paths line found only in CLAUDE.md', () => {
    expect(() => agentsContractPaths('# x\n\nno such line\n', 'Contract paths: contract/surface.json\n'))
      .toThrow(/Contract paths: contract\/surface\.json[\s\S]*moved to AGENTS\.md/)
    expect(() => agentsContractPaths(null, 'Contract paths: contract/surface.json\n'))
      .toThrow(/moved to AGENTS\.md/)
  })

  it('join both sources without duplicates', () => {
    const dir = repository({
      'construct.json': JSON.stringify({ contracts: { path: 'contracts/openapi.yaml', types: 'src/contracts/openapi.ts' } }),
      'AGENTS.md': 'Contract paths: contracts/openapi.yaml, contract/surface.json\n',
    })
    expect(contractPaths(dir)).toEqual(['contracts/openapi.yaml', 'src/contracts/openapi.ts', 'contract/surface.json'])
  })

  it('never read a Contract paths line from CLAUDE.md when AGENTS.md has its own', () => {
    const dir = repository({
      'AGENTS.md': 'Contract paths: contract/surface.json\n',
      'CLAUDE.md': 'Contract paths: claude/only.json\n',
    })
    expect(contractPaths(dir)).toEqual(['contract/surface.json'])
  })

  it('are empty when neither construct.json nor AGENTS.md names one, as in an attached repository', () => {
    expect(contractPaths(repository({ 'AGENTS.md': '# attached\n' }))).toEqual([])
    expect(contractPaths(repository({}))).toEqual([])
  })
})
