import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { messageOf } from '../../core/errors.js'
import { exitCodePath, treeReportPath } from '../../core/places.js'

export const REPORT_MISSING = 'report-missing'

export type ReportCollection
  = | { kind: 'collected', tree: string, saved: string }
    | { kind: 'absent', tree: string }
    | { kind: 'unreadable', tree: string, reason: string }

function removeFromTree(tree: string): void {
  rmSync(tree, { recursive: true, force: true })
}

export function collectReport(worktree: string, saved: string): ReportCollection {
  const tree = treeReportPath(worktree)
  if (!existsSync(tree))
    return { kind: 'absent', tree }
  let text: string
  try {
    text = readFileSync(tree, 'utf8')
  }
  catch (error) {
    removeFromTree(tree)
    return { kind: 'unreadable', tree, reason: messageOf(error) }
  }
  if (text.trim() === '') {
    removeFromTree(tree)
    return { kind: 'unreadable', tree, reason: 'the file is empty' }
  }
  mkdirSync(path.dirname(saved), { recursive: true })
  writeFileSync(saved, text)
  removeFromTree(tree)
  return { kind: 'collected', tree, saved }
}

export function restoreReport(saved: string, worktree: string): void {
  if (!existsSync(saved))
    return
  const tree = treeReportPath(worktree)
  mkdirSync(path.dirname(tree), { recursive: true })
  copyFileSync(saved, tree)
}

export function recordedExitCode(launchDir: string, cardId: number, sinceMs: number): string | null {
  const file = exitCodePath(launchDir, String(cardId))
  if (!existsSync(file) || statSync(file).mtimeMs < sinceMs)
    return null
  const code = readFileSync(file, 'utf8').trim()
  return code === '' ? null : code
}

export function missingReportDetail(cardId: number, collection: Exclude<ReportCollection, { kind: 'collected' }>, exitCode: string | null): string {
  const what = collection.kind === 'absent' ? 'no report was written there' : `the report cannot be read: ${collection.reason}`
  const exit = exitCode === null ? 'no exit code was recorded (the session was stopped or killed)' : `the session exited with code ${exitCode}`
  return `${REPORT_MISSING}: card #${cardId}: the shift report ${collection.tree}: ${what}; ${exit}`
}
