import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export interface ParsedFile {
  file: string
  source: ts.SourceFile
}

export const SCANNED_TREES = ['scripts', 'src']

const CODE_FILE = /\.(?:ts|mts|mjs|js)$/
const TEST_FILE = /\.(?:test|spec|e2e)\.[cm]?[jt]s$/
const SKIPPED_SEGMENTS = new Set(['tests', 'fixtures', 'node_modules'])
const THE_GENERATOR = ['scripts/contract/factory.ts', 'scripts/contract/overlaps.ts']
const THE_GENERATOR_FOLDER = 'scripts/contract/factory/'

function isScanned(file: string): boolean {
  return CODE_FILE.test(file)
    && !TEST_FILE.test(file)
    && !file.split('/').some(segment => SKIPPED_SEGMENTS.has(segment))
    && !THE_GENERATOR.includes(file)
    && !file.startsWith(THE_GENERATOR_FOLDER)
}

function filesUnder(root: string, tree: string): string[] {
  const entries = readdirSync(path.join(root, tree), { withFileTypes: true, recursive: true })
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
}

export function parsedFiles(root: string, trees: readonly string[] = SCANNED_TREES): ParsedFile[] {
  return trees
    .flatMap(tree => filesUnder(root, tree))
    .filter(isScanned)
    .sort()
    .map(file => ({ file, source: ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true) }))
}

export function eachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, child => eachNode(child, visit))
}
