import type { Tree } from '../../done/tree.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readTree } from '../../done/tree.js'
import { unreachedFiles } from '../../done/wiring.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function memoryTree(texts: Record<string, string>): Tree {
  return { files: new Set(Object.keys(texts)), addedLines: () => true, read: file => texts[file]! }
}

describe('a template is wired when product code names its group', () => {
  const repository = readTree(REPO_ROOT, 'HEAD')

  it.each([
    'templates/attach/_construct/commit-guard.mjs',
    'templates/attach/_construct/shell-parser.mjs',
    'templates/presets/node-frontend/sample/src/main.ts',
  ])('%s is wired', (template) => {
    expect(unreachedFiles(repository, [template])).toEqual([])
  })
})

describe('what nothing names stays unwired', () => {
  const tree = memoryTree({
    'src/presets.ts': 'export const GROUPS = [\'attach\']\n',
    'scripts/render.ts': 'export const GROUP = \'orphan\'\n',
    'templates/attach/guard.mjs': 'export const guard = 1\n',
    'templates/orphan/lonely.mjs': 'export const lonely = 1\n',
    'src/alone.ts': 'export const alone = 1\n',
  })

  it.each([
    ['a template whose group no product file names', 'templates/orphan/lonely.mjs'],
    ['a source file nothing imports', 'src/alone.ts'],
  ])('%s', (_, file) => {
    expect(unreachedFiles(tree, [file])).toEqual([file])
  })

  it('a template whose group a product file names is wired', () => {
    expect(unreachedFiles(tree, ['templates/attach/guard.mjs'])).toEqual([])
  })
})
