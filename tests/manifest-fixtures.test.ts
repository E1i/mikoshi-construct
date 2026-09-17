import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, 'fixtures/manifests')
const SCOPE = /@[\w.-]+\//g

function folders(): string[] {
  return readdirSync(ROOT, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

function manifest(folder: string): { vars: Record<string, string>, files: Record<string, string>, construct: string, preset: string } {
  return JSON.parse(readFileSync(path.join(ROOT, folder, 'construct.json'), 'utf8'))
}

describe('the frozen manifests carry a shape and no names', () => {
  it('keeps manifests written by versions today cannot produce', () => {
    const versions = new Set(folders().map(folder => manifest(folder).construct))
    expect(folders().length).toBeGreaterThan(3)
    expect([...versions].sort()).toEqual(['0.1.0', '0.1.1'])
  })

  for (const folder of folders()) {
    it(`${folder} names nothing outside its own invented project`, () => {
      const raw = readFileSync(path.join(ROOT, folder, 'construct.json'), 'utf8')
      const own = manifest(folder).vars.projectName
      expect(folder).toContain('names-replaced')
      expect(own, 'the fixture folder and its project name must agree').toBe(folder.split('-0.1.')[0].replace(/^(monorepo|node-backend|node-frontend)$/, own))
      for (const scope of raw.match(SCOPE) ?? [])
        expect(scope, `${folder}: every scope belongs to the invented project`).toBe(`@${own}/`)
    })

    it(`${folder} is a manifest and not a rendering to compare against`, () => {
      const frozen = manifest(folder)
      expect(Object.keys(frozen.files).length).toBeGreaterThan(10)
      expect(frozen.preset).toBeTruthy()
      expect(frozen.vars.projectName).toBeTruthy()
    })
  }
})
