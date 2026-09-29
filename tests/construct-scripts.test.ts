import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const DIR = 'scripts/construct'

const surface = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/surface.json'), 'utf8')) as { paths: { attach: { writes: string[] } } }

describe(`${DIR} in this repository`, () => {
  it('holds exactly the files attach writes there, so no repository-only helper outlives its callers', () => {
    const written = surface.paths.attach.writes.filter(file => file.startsWith(`${DIR}/`)).sort()
    expect(written.length).toBeGreaterThan(0)
    expect(readdirSync(path.join(REPO_ROOT, DIR)).map(file => `${DIR}/${file}`).sort()).toEqual(written)
  })
})
