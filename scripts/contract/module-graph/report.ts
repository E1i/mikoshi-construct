import type { ModuleGraphSpec } from '../factory/modules.js'
import type { BoundaryReport, Violation, ViolationReason } from './boundary.js'
import type { SourceCycle } from './cycles.js'
import type { ImportEdge } from './imports.js'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isTool, MODULE_GRAPH } from '../factory/modules.js'
import { boundaryViolations, graphImporters, graphModules, stronglyConnected, VIOLATION_REASONS } from './boundary.js'
import { mayUseCycles, sourceCycles } from './cycles.js'
import { buildImportGraph, byText, readAliases } from './imports.js'
import { ownerOf, sourceFiles } from './ownership.js'

export const REPORT_VERSION = 1

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const UNOWNED = 'unowned'
const SPEC_DIGEST = 'sha256'

export const REASONS_NOTE = 'one import may carry several reasons, so these counts do not add up to violatingImports'

export interface ReportFile {
  file: string
  holder: string
}

export interface ReportModule {
  id: string
  status: ModuleGraphSpec['modules'][string]['status']
  inGraph: boolean
  files: number
}

export interface ModuleEdge {
  from: string
  to: string
  imports: number
}

export interface ReportStatistics {
  files: number
  modules: number
  tools: number
  imports: number
  moduleEdges: number
  violatingImports: number
  components: number
  mayUseCycles: number
}

export interface ReasonTable {
  note: string
  counts: Record<ViolationReason, number>
}

export interface ModuleGraphReport {
  reportVersion: number
  spec: { version: string }
  statistics: ReportStatistics
  reasons: ReasonTable
  modules: ReportModule[]
  files: ReportFile[]
  graph: { imports: ImportEdge[], modules: ModuleEdge[] }
  violations: Violation[]
  components: string[][]
  chains: SourceCycle[]
  mayUseCycles: string[][]
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(canonical)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => byText(a, b)).map(([key, inner]) => [key, canonical(inner)]))
  return value
}

export function specVersion(spec: ModuleGraphSpec): string {
  return `${SPEC_DIGEST}:${createHash(SPEC_DIGEST).update(JSON.stringify(canonical(spec))).digest('hex')}`
}

function holderOf(spec: ModuleGraphSpec, file: string): string {
  return ownerOf(spec, file)[0] ?? UNOWNED
}

function reportModules(spec: ModuleGraphSpec, files: readonly ReportFile[]): ReportModule[] {
  const inGraph = new Set(graphModules(spec))
  return Object.keys(spec.modules).sort(byText).map(id => ({
    id,
    status: spec.modules[id]!.status,
    inGraph: inGraph.has(id),
    files: files.filter(({ holder }) => holder === id).length,
  }))
}

function moduleEdges(spec: ModuleGraphSpec, graph: readonly ImportEdge[]): ModuleEdge[] {
  const inGraph = new Set(graphModules(spec))
  const counts = new Map<string, ModuleEdge>()
  for (const { from, to } of graph) {
    const [source, target] = [holderOf(spec, from), holderOf(spec, to)]
    if (source === target || !inGraph.has(source) || !inGraph.has(target))
      continue
    const key = `${source}\n${target}`
    const edge = counts.get(key) ?? { from: source, to: target, imports: 0 }
    edge.imports += 1
    counts.set(key, edge)
  }
  return [...counts.values()].sort((a, b) => byText(a.from, b.from) || byText(a.to, b.to))
}

function orderedViolations(violations: readonly Violation[]): Violation[] {
  return violations
    .map(violation => ({ ...violation, reasons: VIOLATION_REASONS.filter(reason => violation.reasons.includes(reason)) }))
    .sort((a, b) => byText(a.from, b.from) || byText(a.to, b.to))
}

export function reasonTable(violations: readonly Violation[]): ReasonTable {
  const counts = Object.fromEntries(VIOLATION_REASONS.map(reason => [reason, 0])) as Record<ViolationReason, number>
  for (const { reasons } of violations) {
    for (const reason of new Set(reasons))
      counts[reason] += 1
  }
  return { note: REASONS_NOTE, counts }
}

export function moduleGraphReport(spec: ModuleGraphSpec, files: readonly string[], boundary: BoundaryReport): ModuleGraphReport {
  const sortedFiles = [...new Set(files)].sort(byText)
  const reportFiles = sortedFiles.map(file => ({ file, holder: holderOf(spec, file) }))
  const imports = [...boundary.graph].sort((a, b) => byText(a.from, b.from) || byText(a.to, b.to))
  const violations = orderedViolations(boundary.violations)
  const modules = reportModules(spec, reportFiles)
  const edges = moduleEdges(spec, imports)
  const chains = sourceCycles(spec, imports)
  const cycles = mayUseCycles(spec)
  const graphCount = modules.filter(({ inGraph }) => inGraph).length
  return {
    reportVersion: REPORT_VERSION,
    spec: { version: specVersion(spec) },
    statistics: {
      files: sortedFiles.length,
      modules: graphCount,
      tools: modules.filter(({ id }) => isTool(spec.modules[id])).length,
      imports: imports.length,
      moduleEdges: edges.length,
      violatingImports: new Set(violations.map(({ from, to }) => `${from}\n${to}`)).size,
      components: boundary.scc.length,
      mayUseCycles: cycles.length,
    },
    reasons: reasonTable(violations),
    modules,
    files: reportFiles,
    graph: { imports, modules: edges },
    violations,
    components: boundary.scc,
    chains,
    mayUseCycles: cycles,
  }
}

export function repositoryReport(root: string = REPO_ROOT, spec: ModuleGraphSpec = MODULE_GRAPH): ModuleGraphReport {
  const files = sourceFiles(root)
  const graph = buildImportGraph(root, files, graphImporters(spec, files), readAliases(root))
  const boundary = { graph, violations: boundaryViolations(spec, graph), scc: stronglyConnected(spec, graph) }
  return moduleGraphReport(spec, files, boundary)
}

export function renderReport(report: ModuleGraphReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(renderReport(repositoryReport()))
