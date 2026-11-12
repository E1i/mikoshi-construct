import type { ModuleGraphSpec } from '../factory/modules.js'
import type { ImportEdge, PathAliases } from './imports.js'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { heldBy, MODULE_GRAPH } from '../factory/modules.js'
import { buildImportGraph, byText, isCodeFile, readAliases } from './imports.js'
import { ownerOf, sourceFiles } from './ownership.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const COMPOSITION_ROOT = 'composition root'
const EXCLUSION = 'exclusion:'
const UNOWNED = 'unowned'

export const BOUNDARY_PREFIX = 'boundary:'

export const VIOLATION_REASONS = ['from-undecided', 'into-undecided', 'not-in-may-use', 'outside-contract', 'into-composition-root', 'into-exclusion', 'into-unowned'] as const

export type ViolationReason = typeof VIOLATION_REASONS[number]

export interface Violation {
  from: string
  to: string
  fromModule: string
  toHolder: string
  reasons: ViolationReason[]
}

export interface BoundaryReport {
  graph: ImportEdge[]
  violations: Violation[]
  scc: string[][]
}

function holderOf(spec: ModuleGraphSpec, file: string): string {
  return ownerOf(spec, file)[0] ?? UNOWNED
}

function isModule(spec: ModuleGraphSpec, holder: string): boolean {
  return spec.modules[holder] !== undefined
}

function reasonsFor(spec: ModuleGraphSpec, fromModule: string, toHolder: string, to: string): ViolationReason[] {
  if (toHolder === COMPOSITION_ROOT)
    return ['into-composition-root']
  if (toHolder.startsWith(EXCLUSION))
    return ['into-exclusion']
  const source = spec.modules[fromModule]!
  const target = spec.modules[toHolder]
  if (target === undefined)
    return ['into-unowned']
  const reasons: ViolationReason[] = []
  const written = source.may_use.includes(toHolder)
  const intoContract = heldBy(target.contract, to)
  const intoDecidedContractItNames = target.status === 'decided' && written && intoContract
  if (source.status === 'undecided' && !intoDecidedContractItNames)
    reasons.push('from-undecided')
  if (target.status === 'undecided')
    reasons.push('into-undecided')
  if (!written)
    reasons.push('not-in-may-use')
  if (!intoContract)
    reasons.push('outside-contract')
  return reasons
}

export function boundaryViolations(spec: ModuleGraphSpec, graph: readonly ImportEdge[]): Violation[] {
  return graph.flatMap(({ from, to }): Violation[] => {
    const fromModule = holderOf(spec, from)
    const toHolder = holderOf(spec, to)
    if (!isModule(spec, fromModule) || fromModule === toHolder)
      return []
    const reasons = reasonsFor(spec, fromModule, toHolder, to)
    return reasons.length === 0 ? [] : [{ from, to, fromModule, toHolder, reasons }]
  })
}

function moduleEdges(spec: ModuleGraphSpec, graph: readonly ImportEdge[]): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>(Object.keys(spec.modules).sort(byText).map(id => [id, new Set<string>()]))
  for (const { from, to } of graph) {
    const [source, target] = [holderOf(spec, from), holderOf(spec, to)]
    if (source !== target && isModule(spec, source) && isModule(spec, target))
      edges.get(source)!.add(target)
  }
  return edges
}

export function stronglyConnected(spec: ModuleGraphSpec, graph: readonly ImportEdge[]): string[][] {
  const edges = moduleEdges(spec, graph)
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: string[][] = []
  const visit = (node: string): void => {
    index.set(node, index.size)
    low.set(node, index.get(node)!)
    stack.push(node)
    onStack.add(node)
    for (const next of [...edges.get(node)!].sort(byText)) {
      if (!index.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node)!, low.get(next)!))
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
    if (component.length > 1)
      components.push(component.sort(byText))
  }
  for (const node of edges.keys()) {
    if (!index.has(node))
      visit(node)
  }
  return components.sort((a, b) => byText(a[0]!, b[0]!))
}

export function graphImporters(spec: ModuleGraphSpec, files: readonly string[]): string[] {
  return files.filter(file => isCodeFile(file) && !holderOf(spec, file).startsWith(EXCLUSION))
}

export function boundaryReport(root: string = REPO_ROOT, spec: ModuleGraphSpec = MODULE_GRAPH, aliases: PathAliases = readAliases(root)): BoundaryReport {
  const files = sourceFiles(root)
  const graph = buildImportGraph(root, files, graphImporters(spec, files), aliases)
  return { graph, violations: boundaryViolations(spec, graph), scc: stronglyConnected(spec, graph) }
}

export function boundaryNumbers(violations: readonly Violation[]): Record<string, number> {
  const numbers: Record<string, number> = {}
  for (const { fromModule, toHolder } of violations) {
    const key = `${BOUNDARY_PREFIX}${fromModule}->${toHolder.replaceAll(' ', '-')}`
    numbers[key] = (numbers[key] ?? 0) + 1
  }
  return numbers
}

export function violationLine({ from, to, reasons }: Violation): string {
  return `${from} -> ${to}: ${reasons.join(', ')}`
}

export function renderBoundaryReport(report: BoundaryReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(renderBoundaryReport(boundaryReport()))
