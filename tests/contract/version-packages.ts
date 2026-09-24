import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface VersionPackagesEdit {
  path: string
  before?: (root: string) => void
  after: (root: string) => void
}

const NEXT_VERSION = '99.0.0'

function prepend(root: string, file: string, text: string): void {
  const target = path.join(root, file)
  writeFileSync(target, `${text}${existsSync(target) ? readFileSync(target, 'utf8') : ''}`)
}

export const VERSION_PACKAGES_EDITS: VersionPackagesEdit[] = [
  {
    path: '.changeset/cli-runtime-label.md',
    before: root => writeFileSync(path.join(root, '.changeset/cli-runtime-label.md'), '---\n"mikoshi-construct": patch\n---\n\ncli: a pending change\n'),
    after: root => rmSync(path.join(root, '.changeset/cli-runtime-label.md')),
  },
  {
    path: 'CHANGELOG.md',
    after: root => prepend(root, 'CHANGELOG.md', `## ${NEXT_VERSION}\n\n### Patch Changes\n\n- cli: a pending change\n\n`),
  },
  {
    path: 'docs/release-notes/index.md',
    after: root => prepend(root, 'docs/release-notes/index.md', `## ${NEXT_VERSION}\n\ncli: a pending change\n\n`),
  },
  {
    path: 'package.json',
    after: (root) => {
      const file = path.join(root, 'package.json')
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      writeFileSync(file, `${JSON.stringify({ ...manifest, version: NEXT_VERSION }, null, 2)}\n`)
    },
  },
]
