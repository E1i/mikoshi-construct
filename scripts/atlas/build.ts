import type { AtlasBuild } from './gates.js'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runAtlas } from '../../src/atlas/index.js'
import { docsFileOf } from '../../src/atlas/switch.js'
import { readModel } from '../../src/model/write.js'

export const ATLAS_FIXTURE = path.resolve(import.meta.dirname, '../../tests/fixtures/atlas/orchard')

function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=atlas@construct', '-c', 'user.name=atlas', ...args], { cwd: dir, stdio: 'ignore' })
}

export function copyFixture(fixture: string = ATLAS_FIXTURE): string {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'atlas-gate-')), path.basename(fixture))
  cpSync(fixture, root, { recursive: true })
  return root
}

export function buildAtlas(root: string): AtlasBuild {
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'fixture')
  const { page } = runAtlas({ dir: root, home: path.join(path.dirname(root), 'home'), attached: false })
  const docs = path.join(path.dirname(page), docsFileOf(page))
  const model = readModel(root)
  if (model == null)
    throw new Error(`${root}: the Atlas was built and its Engram cannot be read back`)
  return {
    root,
    model,
    map: { file: page, html: readFileSync(page, 'utf8') },
    docs: { file: docs, html: readFileSync(docs, 'utf8') },
  }
}
