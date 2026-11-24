import type { AdmitResult } from '../../../src/commands/intake/admit.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryDecisions } from '../../../scripts/policy/decisions/decisions.js'
import { parkingFileText } from '../../../src/card/parking.js'
import { runAdmit } from '../../../src/commands/intake/admit.js'

const NOW = new Date('2026-11-24T10:00:00.000Z')
const CARD = 4236
const CREATED = 'src/feature.ts'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function productRepository(root: string): string {
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'product', bin: { product: 'dist/cli.js' } }))
  writeFileSync(path.join(repo, 'src', 'cli.ts'), 'import { run } from \'./program.js\'\n\nrun()\n')
  writeFileSync(path.join(repo, 'src', 'program.ts'), 'export function run(): void {}\n')
  writeFileSync(path.join(repo, 'src', 'island.ts'), 'export const island = 1\n')
  return repo
}

function admit(touches: readonly string[]): AdmitResult {
  const root = mkdtempSync(path.join(tmpdir(), 'reachable-from-entry-'))
  roots.push(root)
  const repo = productRepository(root)
  const parking = path.join(root, 'parking')
  mkdirSync(parking, { recursive: true })
  const file = path.join(parking, `${CARD}.md`)
  writeFileSync(file, parkingFileText({
    card: `#${CARD} new-feature [implement/construct/S/cheap/auto] · depends — · blocks —`,
    branch: 'feat/new-feature',
    touches: [...touches, CREATED],
    creates: [CREATED],
    continue: 'stop',
    who: 'shift',
    body: 'Add the feature module.',
  }))
  return runAdmit({ file, dir: repo, dryRun: true, autoConfirm: true, parkingRoot: parking, contourMap: path.join(root, 'contour-map.json'), decisions: new InMemoryDecisions([]) }, () => NOW)
}

describe('a witness must be reachable from an entry point of the product', () => {
  it('a card whose new module no entry point imports is refused at admit with the reason', () => {
    const result = admit(['src/island.ts'])

    expect(result.status).toBe('refused')
    expect(result.status === 'refused' ? result.why : '').toContain(`#${CARD} creates ${CREATED}, a product module, and no touch reaches an entry point of the stack (bin dist/cli.js)`)
  })

  it('a card whose new module an entry point named by the stack adapter imports is admitted', () => {
    const result = admit(['src/program.ts'])

    expect(result.status).toBe('dryRun')
  })
})
