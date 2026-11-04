import type { ServeRecord } from '../../src/presets/index.js'
import path from 'node:path'
import { readAttachRecord } from '../../src/commands/attach/record.js'
import { MANIFEST_FILE, upgradeManifest } from '../../src/manifest.js'
import { gitIn } from './worktree.js'

function serveInManifest(tree: string, head: string): ServeRecord | null {
  try {
    return upgradeManifest(JSON.parse(gitIn(tree, ['show', `${head}:${MANIFEST_FILE}`]))).serve ?? null
  }
  catch {
    return null
  }
}

function serveInAttachRecord(tree: string): ServeRecord | null {
  try {
    const root = path.dirname(gitIn(tree, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim())
    return upgradeManifest({ serve: readAttachRecord(root)?.serve }).serve ?? null
  }
  catch {
    return null
  }
}

export function serveRecordAt(tree: string, head: string): ServeRecord | null {
  return serveInManifest(tree, head) ?? serveInAttachRecord(tree)
}
