import type { Concept } from '../../scripts/contract/factory/concepts.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { conceptsSection } from '../../scripts/contract/factory.js'
import { assertOwnersExport, CONCEPTS, exportedNames, ownerExportFault } from '../../scripts/contract/factory/concepts.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const OWNER = 'scripts/seeded/owner.ts'

const scratchRoots: string[] = []

function fixtureTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'concept-owner-'))
  scratchRoots.push(root)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

afterAll(() => {
  scratchRoots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function built(ownerExport: string): Concept {
  return { id: 'seeded', title: 'seeded', owner: OWNER, ownerExists: true, ownerExport, axis: 'architecture', lore: null, detectors: [] }
}

function proposed(): Concept {
  return { id: 'seeded', title: 'seeded', owner: OWNER, ownerExists: false, ownerExport: null, axis: 'architecture', lore: null, detectors: [] }
}

describe('a concept\'s owner is checked at the export, not the file', () => {
  it('a concept whose owner file lacks the named export is red', () => {
    const root = fixtureTree({ [OWNER]: 'export function renamedOwner(): void {}\n' })

    expect(ownerExportFault(built('seededOwner'), root)).toBe(`seeded: ${OWNER} does not export seededOwner`)
    expect(() => conceptsSection({}, [built('seededOwner')], root)).toThrow(`${OWNER} does not export seededOwner`)
    expect(ownerExportFault(built('renamedOwner'), root)).toBeNull()
    expect(Object.keys(conceptsSection({}, [built('renamedOwner')], root))).toEqual(['seeded'])
  })

  it('a concept that claims an owner which is no file is red', () => {
    expect(ownerExportFault(built('seededOwner'), fixtureTree({}))).toBe(`seeded: ownerExists is true but ${OWNER} is not a file`)
  })

  it('every concept with an existing owner exports the name it declares', () => {
    const owned = CONCEPTS.filter(concept => concept.ownerExists)

    expect(owned.length).toBeGreaterThan(0)
    for (const concept of owned) {
      if (concept.ownerExists)
        expect(exportedNames(path.join(REPO_ROOT, concept.owner)), `${concept.id}: ${concept.owner}`).toContain(concept.ownerExport)
    }
    expect(() => assertOwnersExport(CONCEPTS, REPO_ROOT)).not.toThrow()
  })

  it('a concept with no owner file yet stays ownerExists false', () => {
    expect(ownerExportFault(proposed(), fixtureTree({}))).toBeNull()
    expect(ownerExportFault(proposed(), fixtureTree({ [OWNER]: 'export const seeded = 1\n' }))).toBe(`seeded: ${OWNER} exists, so name the export it owns the concept by and set ownerExists true`)
    for (const concept of CONCEPTS.filter(concept => !concept.ownerExists)) {
      expect(concept.ownerExport, concept.id).toBeNull()
      expect(existsSync(path.join(REPO_ROOT, concept.owner)), concept.id).toBe(false)
      expect(conceptsSection({})[concept.id]!.ownerExists, concept.id).toBe(false)
    }
  })

  it('reads every form a module exports a name by, and not a local one', () => {
    const root = fixtureTree({
      [OWNER]: [
        'function local(): void {}',
        'const aliased = 1',
        'export function declared(): void {}',
        'export const first = 1, second = 2',
        'export class Owner {}',
        'export interface Shape { a: number }',
        'export type Alias = Shape',
        'export enum Kind { A }',
        'export { aliased as renamed }',
        'export { reexported } from \'./other.js\'',
        'export default local',
        '',
      ].join('\n'),
    })

    expect([...exportedNames(path.join(root, OWNER))].sort()).toEqual(['Alias', 'Kind', 'Owner', 'Shape', 'declared', 'default', 'first', 'reexported', 'renamed', 'second'])
  })
})
