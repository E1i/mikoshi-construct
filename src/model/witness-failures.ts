import type { Fact, RepositoryModel } from './schema.js'
import type { FactEvaluation, ModelEvidence } from './state.js'
import path from 'node:path'
import { surfaceOf } from './coverage.js'
import { failuresOf, readTestReport } from './test-report.js'

function coveringTestsFailed(fact: Fact, root: string, constructPaths: readonly string[]): boolean {
  const report = readTestReport(fact.format ?? 'vitest-json', root, path.join(root, fact.path))
  if ('unreadable' in report)
    return false
  const surface = new Set(surfaceOf(fact, root, new Set(constructPaths)))
  return failuresOf(report).some(failure => surface.has(failure.file))
}

export function failedWitnesses(model: RepositoryModel, root: string, evaluations: Record<string, FactEvaluation>, evidence: ModelEvidence): ReadonlySet<string> {
  if (evidence.reports !== 'read')
    return new Set()
  const { constructPaths } = evidence
  return new Set(model.facts
    .filter(fact => fact.kind === 'report-covers' && evaluations[fact.id] === 'holds' && coveringTestsFailed(fact, root, constructPaths))
    .map(fact => fact.id))
}
