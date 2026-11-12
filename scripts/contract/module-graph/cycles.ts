import type { ModuleGraphSpec } from '../factory/modules.js'
import type { BoundaryReport, ViolationReason } from './boundary.js'
import type { ImportEdge } from './imports.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { MODULE_GRAPH } from '../factory/modules.js'
import { boundaryReport, graphModules, stronglyConnected, VIOLATION_REASONS } from './boundary.js'
import { byText } from './imports.js'
import { ownerOf } from './ownership.js'

const CHAIN_ARROW = ' -> '

export interface ChainStep {
  from: string
  to: string
  import: Pick<ImportEdge, 'from' | 'to'>
}

export interface SourceCycle {
  scc: string[]
  chain: ChainStep[]
}

export interface CyclesReport {
  mayUse: string[][]
  source: SourceCycle[]
}

export interface ModuleGraphSummary {
  modules: number
  tools: number
  violatingImports: number
  violations: Record<ViolationReason, number>
  cycles: CyclesReport
}

type Edges = ReadonlyMap<string, readonly string[]>

function mayUseEdges(spec: ModuleGraphSpec): Edges {
  return new Map(graphModules(spec).map(id => [id, [...spec.modules[id]!.may_use].sort(byText)]))
}

function components(edges: Edges): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const found: string[][] = []
  const visit = (node: string): void => {
    index.set(node, index.size)
    low.set(node, index.get(node)!)
    stack.push(node)
    onStack.add(node)
    for (const next of edges.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node)!, low.get(next) ?? Infinity))
      }
      else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, index.get(next)!))
      }
    }
    if (low.get(node) !== index.get(node))
      return
    const component: string[] = []
    let member: string | undefined
    do {
      member = stack.pop()!
      onStack.delete(member)
      component.push(member)
    } while (member !== node)
    if (component.length > 1 || (edges.get(node) ?? []).includes(node))
      found.push(component.sort(byText))
  }
  for (const node of edges.keys()) {
    if (!index.has(node))
      visit(node)
  }
  return found.sort((a, b) => byText(a[0]!, b[0]!))
}

export function mayUseCycles(spec: ModuleGraphSpec): string[][] {
  return components(mayUseEdges(spec))
}

function holderOf(spec: ModuleGraphSpec, file: string): string | undefined {
  return ownerOf(spec, file)[0]
}

function witnessImports(spec: ModuleGraphSpec, graph: readonly ImportEdge[], members: ReadonlySet<string>): Map<string, Pick<ImportEdge, 'from' | 'to'>> {
  const witnesses = new Map<string, Pick<ImportEdge, 'from' | 'to'>>()
  for (const { from, to } of graph) {
    const [source, target] = [holderOf(spec, from), holderOf(spec, to)]
    if (source === undefined || target === undefined || source === target || !members.has(source) || !members.has(target))
      continue
    const key = `${source}\n${target}`
    if (!witnesses.has(key))
      witnesses.set(key, { from, to })
  }
  return witnesses
}

function shortestLoop(start: string, next: (node: string) => string[]): string[] {
  const parent = new Map<string, string>()
  const queue = [start]
  while (queue.length > 0) {
    const node = queue.shift()!
    for (const target of next(node)) {
      if (target === start) {
        const loop = [node]
        while (loop[0] !== start)
          loop.unshift(parent.get(loop[0]!)!)
        return [...loop, start]
      }
      if (!parent.has(target)) {
        parent.set(target, node)
        queue.push(target)
      }
    }
  }
  return []
}

function exampleChain(scc: readonly string[], witnesses: ReadonlyMap<string, Pick<ImportEdge, 'from' | 'to'>>): ChainStep[] {
  const next = (node: string): string[] => scc.filter(target => witnesses.has(`${node}\n${target}`))
  const loop = shortestLoop(scc[0]!, next)
  return loop.slice(1).map((to, step) => {
    const from = loop[step]!
    return { from, to, import: witnesses.get(`${from}\n${to}`)! }
  })
}

export function sourceCycles(spec: ModuleGraphSpec, graph: readonly ImportEdge[]): SourceCycle[] {
  const sorted = [...graph].sort((a, b) => byText(a.from, b.from) || byText(a.to, b.to))
  return stronglyConnected(spec, graph).map(scc => ({ scc, chain: exampleChain(scc, witnessImports(spec, sorted, new Set(scc))) }))
}

export function cyclesReport(spec: ModuleGraphSpec, graph: readonly ImportEdge[]): CyclesReport {
  return { mayUse: mayUseCycles(spec), source: sourceCycles(spec, graph) }
}

export function mayUseCycleLine(cycle: readonly string[]): string {
  return `may_use cycle: ${cycle.join(', ')}`
}

export function chainLine(chain: readonly ChainStep[]): string {
  return chain.map(({ from, import: { from: file, to } }) => `${from} (${file}${CHAIN_ARROW}${to})`).concat(chain.at(-1)?.to ?? []).join(CHAIN_ARROW)
}

export function sourceCycleLine({ scc, chain }: SourceCycle): string {
  return `source SCC [${scc.join(', ')}]: ${chainLine(chain)}`
}

function violationsByReason(report: BoundaryReport): Record<ViolationReason, number> {
  const counts = Object.fromEntries(VIOLATION_REASONS.map(reason => [reason, 0])) as Record<ViolationReason, number>
  for (const { reasons } of report.violations) {
    for (const reason of reasons)
      counts[reason] += 1
  }
  return counts
}

export function moduleGraphSummary(spec: ModuleGraphSpec = MODULE_GRAPH, report: BoundaryReport = boundaryReport(undefined, spec)): ModuleGraphSummary {
  const modules = graphModules(spec).length
  return { modules, tools: Object.keys(spec.modules).length - modules, violatingImports: report.violations.length, violations: violationsByReason(report), cycles: cyclesReport(spec, report.graph) }
}

export function renderSummary(summary: ModuleGraphSummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = moduleGraphSummary()
  process.stdout.write(renderSummary(summary))
  if (summary.cycles.mayUse.length > 0) {
    process.stderr.write(`${summary.cycles.mayUse.map(mayUseCycleLine).join('\n')}\n`)
    process.exitCode = 1
  }
}
