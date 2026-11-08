import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findSites } from '../../contract/factory/overlaps.js'

const SEEDED = 'scripts/seeded/commands.ts'

const SEEDED_LINES = [
  `import { execFileSync, spawnSync } from 'node:child_process'`,
  `const INSTALL = 'pnpm install --frozen-lockfile'`,
  `export const told = 'run pnpm handoff:write first'`,
  `export const installed = spawnSync('sh', ['-c', INSTALL])`,
  `export const quality = execFileSync('node', ['cli.js', '--harness', 'pnpm run quality'])`,
  `export function* commands(files: string[]) { yield \`pnpm exec eslint \${files.join(' ')}\` }`,
  `export const usage = \`usage: pnpm miko:watch [--once]\``,
  `export const failed = \`\${INSTALL} failed\``,
]

const OWNER_COMMAND_LINES = [3, 7]

const scratchRoots: string[] = []

function fixtureTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'owner-commands-'))
  scratchRoots.push(root)
  mkdirSync(path.join(root, 'src'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

afterAll(() => {
  scratchRoots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function ownerCommandLines(root: string): number[] {
  return findSites(root).filter(site => site.concept === 'owner-commands').map(site => site.line)
}

describe('owner-commands detector', () => {
  it('a command the code runs itself is not an owner command', () => {
    const root = fixtureTree({ [SEEDED]: `${SEEDED_LINES.join('\n')}\n` })

    expect(ownerCommandLines(root)).toEqual(OWNER_COMMAND_LINES)
  })

  it('a constant the code never runs stays an owner command', () => {
    const root = fixtureTree({ [SEEDED]: `const SAY = 'pnpm owner:say hello'\nexport const line = \`\${SAY} now\`\nexport const shown = console.log(SAY)\n` })

    expect(ownerCommandLines(root)).toEqual([1])
  })

  it('a command bound into a statement parameter is not run by the code', () => {
    const root = fixtureTree({ [SEEDED]: `const AMEND = 'pnpm intake --admit '\nexport function amend(statement: { run: (...values: unknown[]) => void }) { statement.run(AMEND.length, AMEND) }\n` })

    expect(ownerCommandLines(root)).toEqual([1])
  })
})
