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
    expect(ownerExportFault(built('seededOwner'), fixtureTree({ [`${OWNER}/index.ts`]: 'export function seededOwner(): void {}\n' }))).toBe(`seeded: ownerExists is true but ${OWNER} is not a file`)
  })

  it('a default declaration exports the name default, not its own name, named or anonymous', () => {
    const root = fixtureTree({
      'scripts/seeded/function.ts': 'export default function seededOwner(): void {}\n',
      'scripts/seeded/class.ts': 'export default class SeededOwner {}\n',
      'scripts/seeded/anonymous.ts': 'export default function (): void {}\n',
      'scripts/seeded/anonymous-class.ts': 'export default class {}\n',
    })

    expect([...exportedNames(path.join(root, 'scripts/seeded/function.ts'))]).toEqual(['default'])
    expect([...exportedNames(path.join(root, 'scripts/seeded/class.ts'))]).toEqual(['default'])
    expect([...exportedNames(path.join(root, 'scripts/seeded/anonymous.ts'))]).toEqual(['default'])
    expect([...exportedNames(path.join(root, 'scripts/seeded/anonymous-class.ts'))]).toEqual(['default'])
  })

  it('a name reachable only through export * from is not seen, so its owner is red; export * as ns exports ns', () => {
    const root = fixtureTree({
      [OWNER]: 'export * from \'./inner.js\'\nexport * as seededSpace from \'./inner.js\'\n',
      'scripts/seeded/inner.ts': 'export function seededOwner(): void {}\n',
    })

    expect([...exportedNames(path.join(root, OWNER))]).toEqual(['seededSpace'])
    expect(ownerExportFault(built('seededOwner'), root)).toBe(`seeded: ${OWNER} does not export seededOwner`)
    expect(ownerExportFault(built('seededSpace'), root)).toBeNull()
  })

  it('every concept with an existing owner exports the name it declares', () => {
    const owned = CONCEPTS.filter(concept => concept.ownerExists)

    expect(owned.length).toBeGreaterThan(0)
    for (const concept of owned)
      expect(ownerExportFault(concept, REPO_ROOT), `${concept.id}: ${concept.owner}`).toBeNull()
    expect(() => assertOwnersExport(CONCEPTS, REPO_ROOT)).not.toThrow()
  })

  it('a folder owner is read at its index.ts', () => {
    const folder: Concept = { ...built('seededOwner'), owner: 'scripts/seeded/' }

    expect(ownerExportFault(folder, fixtureTree({ 'scripts/seeded/index.ts': 'export { seededOwner } from \'./owner.js\'\n', 'scripts/seeded/owner.ts': 'export function seededOwner(): void {}\n' }))).toBeNull()
    expect(ownerExportFault(folder, fixtureTree({ 'scripts/seeded/index.ts': 'export const other = 1\n' }))).toBe('seeded: scripts/seeded/index.ts does not export seededOwner')
    expect(ownerExportFault(folder, fixtureTree({ 'scripts/seeded/owner.ts': 'export function seededOwner(): void {}\n' }))).toBe('seeded: ownerExists is true but scripts/seeded/index.ts is not a file')
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
