import type { Fact } from './schema.js'
import type { FactEvaluation } from './state.js'
import type { ReportedFile } from './vitest-report.js'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { matchesAnyGlob } from './glob.js'
import { readVitestReport, wasExecuted } from './vitest-report.js'

const NEVER_SURFACE_DIRECTORIES = new Set(['.git', 'node_modules'])

function repositoryFiles(root: string, directory = ''): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = directory === '' ? entry.name : `${directory}/${entry.name}`
    if (entry.isDirectory())
      return NEVER_SURFACE_DIRECTORIES.has(entry.name) ? [] : repositoryFiles(root, relative)
    return entry.isFile() ? [relative] : []
  })
}

function surfaceOf(fact: Fact, root: string, constructPaths: ReadonlySet<string>): string[] {
  return repositoryFiles(root).filter(file => file !== fact.path && !constructPaths.has(file) && matchesAnyGlob(file, fact.surface ?? []))
}

function isMapped(entry: ReportedFile): boolean {
  return !path.isAbsolute(entry.file) && !entry.file.startsWith('../')
}

function modifiedAt(root: string, file: string): number {
  return statSync(path.join(root, file)).mtimeMs
}

export function evaluateCoverage(fact: Fact, root: string, constructPaths: readonly string[]): FactEvaluation {
  const reportPath = path.join(root, fact.path)
  if (!existsSync(reportPath))
    return 'unevaluable'
  const report = readVitestReport(root, reportPath)
  if ('unreadable' in report)
    return 'unevaluable'
  const surface = surfaceOf(fact, root, new Set(constructPaths))
  if (surface.length === 0)
    return 'unevaluable'
  const reportedAt = modifiedAt(root, fact.path)
  if (surface.some(file => modifiedAt(root, file) >= reportedAt))
    return 'unevaluable'
  const inSurface = new Set(surface)
  if (report.files.some(entry => wasExecuted(entry) && inSurface.has(entry.file)))
    return 'holds'
  if (!report.files.every(isMapped))
    return 'unevaluable'
  return 'does-not-hold'
}
