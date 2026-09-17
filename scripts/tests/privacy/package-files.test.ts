import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const FORBIDDEN_PREFIXES = ['.construct/', 'findings/', 'runs/']

describe('published package', () => {
  it('carries no run or findings data', () => {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: REPO_ROOT, encoding: 'utf8' })
    const files = (JSON.parse(output) as { files: { path: string }[] }[])[0].files.map(file => file.path)
    expect(files.length).toBeGreaterThan(0)
    expect(files.filter(file => FORBIDDEN_PREFIXES.some(prefix => file.startsWith(prefix)))).toEqual([])
  })
})
