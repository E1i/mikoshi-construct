import path from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { callsGitHub, GH_PORT, ghCallers, knownCallers, repositorySources, staleCallers, unrecordedCallers } from '../../core/gh-callers.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

describe('the GitHub API is called through one port, and every other caller is recorded', () => {
  const sources = repositorySources(REPO_ROOT)
  const found = ghCallers(sources)
  const known = knownCallers(REPO_ROOT)

  it('gh spawned outside the port is exactly the recorded baseline', () => {
    expect(unrecordedCallers(found, known)).toEqual([])
    expect(staleCallers(found, known)).toEqual([])
    expect(known).toEqual([...known].sort())
    expect(sources.has(GH_PORT)).toBe(true)
    expect(found).not.toContain(GH_PORT)
    expect(found).not.toContain('scripts/bus/github.ts')
  })

  it('no GitHub caller outside the port and the registry is empty', () => {
    expect(found).toEqual([])
    expect(known).toEqual([])
    expect(sources.has('src/cli.ts')).toBe(true)
    expect(sources.has('.github/workflows/ci.yml')).toBe(true)
  })

  it('a fetch of api.github.com outside the port is a caller', () => {
    expect(callsGitHub('scripts/ci/x.ts', `export const cancel = (run: string) => fetch(\`https://api.github.com/repos/o/r/actions/runs/\${run}/cancel\`, { method: 'POST' })\n`)).toBe(true)
    expect(callsGitHub('scripts/ci/y.ts', `const API = 'https://api.github.com'\nexport const read = (path: string) => fetch(\`\${API}\${path}\`)\n`)).toBe(true)
    expect(callsGitHub('scripts/ci/z.ts', `export const read = () => fetch('https://registry.npmjs.org/mikoshi-construct')\n`)).toBe(false)
  })

  it('a gh call in a workflow step is a caller', () => {
    const workflow = (run: string): string => YAML.stringify({ name: 'w', on: { push: null }, jobs: { j: { 'runs-on': 'ubuntu-24.04', 'steps': [{ uses: 'actions/checkout@v7' }, { run }] } } })
    expect(ghCallers(new Map([['.github/workflows/x.yml', workflow('count=$(gh api "repos/$REPOSITORY/actions/runs/1/artifacts" --jq .total_count)\n')]]))).toEqual(['.github/workflows/x.yml'])
    expect(ghCallers(new Map([['.github/workflows/x.yml', workflow('node -e "fetch(\'https://api.github.com/repos/o/r\')"')]]))).toEqual(['.github/workflows/x.yml'])
    expect(ghCallers(new Map([['.github/workflows/x.yml', workflow('pnpm run release:verify\ngit push origin gh-pages\n')]]))).toEqual([])
  })

  it('a planted gh call under src is a caller', () => {
    const planted = new Map(sources)
    planted.set('src/commands/sneak.ts', `import { execFileSync } from 'node:child_process'\nexport const sneak = () => execFileSync('gh', ['pr', 'list'])\n`)
    expect(unrecordedCallers(ghCallers(planted), known)).toEqual(['src/commands/sneak.ts'])
  })

  it('a new spawn of gh outside the port fails', () => {
    const sneaking = new Map(sources)
    sneaking.set('scripts/bus/sneak.ts', `import { execFileSync } from 'node:child_process'\nexport const sneak = () => execFileSync('gh', ['pr', 'list'])\n`)
    expect(unrecordedCallers(ghCallers(sneaking), known)).toEqual(['scripts/bus/sneak.ts'])
  })

  it('a file that names gh without spawning anything, or spawns something else, is no caller', () => {
    expect(callsGitHub('a.ts', `export const tokens = ['gh', 'pr']\n`)).toBe(false)
    expect(callsGitHub('b.ts', `import { execFileSync } from 'node:child_process'\nexecFileSync('git', ['status'])\nthrow new Error('gh unavailable')\n`)).toBe(false)
    expect(callsGitHub('c.ts', `import { execFileSync } from 'node:child_process'\nexport const line = \`gh pr merge 1\`\nexecFileSync('git', ['log'])\n`)).toBe(false)
  })

  const ESCAPES: Record<string, Map<string, string>> = {
    'a default parameter': new Map([['scripts/x.ts', `import { spawnSync } from 'node:child_process'\nexport function api(command = 'gh') { return spawnSync(command, []) }\n`]]),
    'a default import of child_process': new Map([['scripts/x.ts', `import cp from 'node:child_process'\nexport const run = () => cp.execFileSync('gh', ['pr', 'list'])\n`]]),
    'a namespace import of child_process': new Map([['scripts/x.ts', `import * as cp from 'child_process'\nexport const run = () => cp.spawnSync('gh', [])\n`]]),
    'a dynamic import': new Map([['scripts/x.ts', `export async function run() {\n  const { execFileSync } = await import('node:child_process')\n  return execFileSync('gh', ['pr', 'list'])\n}\n`]]),
    'a require': new Map([['scripts/x.mjs', `const { execFileSync } = require('child_process')\nexecFileSync('gh', ['pr', 'list'])\n`]]),
    'a local constant': new Map([['scripts/x.ts', `import { execFileSync } from 'node:child_process'\nconst BIN = 'gh'\nexecFileSync(BIN, ['pr', 'list'])\n`]]),
    'a constant from another module': new Map([['scripts/names.ts', `export const GH_BIN = 'gh'\n`], ['scripts/x.ts', `import { execFileSync } from 'node:child_process'\nimport { GH_BIN as BIN } from './names.js'\nexecFileSync(BIN, ['pr', 'list'])\n`]]),
    'a shell line': new Map([['scripts/x.ts', `import { execSync } from 'node:child_process'\nexport const run = (pr: number) => execSync(\`gh pr view \${pr}\`)\n`]]),
    'a spawn helper of another module': new Map([['scripts/x.js', `import { run } from './proc.js'\nrun('gh', ['pr', 'list'])\n`]]),
  }

  for (const [form, files] of Object.entries(ESCAPES)) {
    it(`gh spawned through ${form} is a caller`, () => {
      expect(ghCallers(files)).toEqual(['scripts/x.ts', 'scripts/x.mjs', 'scripts/x.js'].filter(file => files.has(file)))
    })
  }

  it('a command read at run time, or a module name built at run time, is beyond the scan and left to review', () => {
    expect(callsGitHub('scripts/x.ts', `import { execFileSync } from 'node:child_process'\nexecFileSync(process.env.GH_BIN!, ['pr', 'list'])\n`)).toBe(false)
    expect(callsGitHub('scripts/x.ts', `const name = ['child', 'process'].join('_')\nconst { execFileSync } = require(name)\nexecFileSync(['g', 'h'].join(''), [])\n`)).toBe(false)
  })

  it('a recorded caller that no longer calls GitHub fails, so the list only shrinks', () => {
    const gone = 'scripts/bus/retired.ts'
    expect(staleCallers(found, [...known, gone])).toEqual([gone])
    const caller = `import { execFileSync } from 'node:child_process'\nexport const run = () => execFileSync('gh', ['pr', 'list'])\n`
    const migrated = new Map([[gone, caller]])
    expect(staleCallers(ghCallers(migrated), [gone])).toEqual([])
    migrated.set(gone, `export const migrated = true\n`)
    expect(staleCallers(ghCallers(migrated), [gone])).toEqual([gone])
  })
})
