import type { AbilityFinding } from '../model/ability.js'
import type { PictureClass } from '../model/graph.js'
import type { AbilityNode, Component, Fact, RepositoryModel } from '../model/schema.js'
import type { EngramStateReport } from '../model/state.js'
import { factClass, factLines, reportBackedIn, RUNTIME_REPORT } from '../model/graph.js'

export interface AtlasMechanics {
  components: Component[]
  relations: { from: string, to: string | null, kind: string, specifier: string, status: string, source: { path: string, line: number } }[]
}

export interface AtlasInput {
  projectName: string
  model: RepositoryModel
  states: EngramStateReport
  mechanics?: AtlasMechanics
}

export interface AtlasEvidence {
  subject: string
  word: string
  state: PictureClass
}

export interface AtlasLink {
  anchor: string
  label: string
}

export interface AtlasNode {
  anchor: string
  label: string
  state: PictureClass
  ability: AbilityFinding
  sourcePath: string
  evidence: AtlasEvidence[]
  leadsFrom: AtlasLink[]
  leadsTo: AtlasLink[]
  components: string[]
}

export interface AtlasStage {
  id: string
  label: string
  nodes: AtlasNode[]
}

export interface Atlas {
  stages: AtlasStage[]
  unclaimed: string[]
}

function anchors(ids: string[]): Map<string, string> {
  const taken = new Set<string>()
  return new Map(ids.map((id) => {
    const base = id.replaceAll(/[^\w.-]/g, '_')
    let candidate = base
    for (let suffix = 2; taken.has(candidate); suffix += 1)
      candidate = `${base}-${suffix}`
    taken.add(candidate)
    return [id, candidate]
  }))
}

function sourcePathOf(node: AbilityNode, facts: Fact[]): string {
  if ('path' in node.source)
    return node.source.path
  const { fact } = node.source
  return facts.find(candidate => candidate.id === fact)?.path ?? fact
}

const NOT_EVALUATED: AbilityFinding = { status: 'unknown', reason: 'not-run', state: 'unknown' }

function lies(componentPath: string, sourcePath: string): boolean {
  return componentPath === sourcePath || componentPath.startsWith(`${sourcePath.replace(/\/$/, '')}/`)
}

export function atlasOf({ model, states, mechanics }: AtlasInput): Atlas {
  const anchorOf = anchors(model.nodes.map(node => node.id))
  const labelOf = new Map(model.nodes.map(node => [node.id, node.label]))
  const reportBacked = reportBackedIn(model)
  const componentPaths = (mechanics?.components ?? []).map(component => component.path)
  const claimed = new Set<string>()

  const link = (id: string): AtlasLink => ({ anchor: anchorOf.get(id) ?? id, label: labelOf.get(id) ?? id })

  const nodeOf = (node: AbilityNode): AtlasNode => {
    const sourcePath = sourcePathOf(node, model.facts)
    const components = componentPaths.filter(path => lies(path, sourcePath))
    components.forEach(path => claimed.add(path))
    return {
      anchor: anchorOf.get(node.id) ?? node.id,
      label: node.label,
      state: reportBacked(node.supportedBy) ? RUNTIME_REPORT : (states.nodes[node.id]?.state ?? 'unknown'),
      ability: states.nodes[node.id] ?? NOT_EVALUATED,
      sourcePath,
      evidence: node.supportedBy.flatMap((factId) => {
        const fact = model.facts.find(candidate => candidate.id === factId)
        if (fact == null)
          return []
        const lines = factLines(fact, states)
        return [{ subject: lines[0], word: lines[1], state: factClass(fact, states) }]
      }),
      leadsFrom: model.links.filter(candidate => candidate.to === node.id).map(candidate => link(candidate.from)),
      leadsTo: model.links.filter(candidate => candidate.from === node.id).map(candidate => link(candidate.to)),
      components,
    }
  }

  const stages = model.stages.map(stage => ({
    id: stage.id,
    label: stage.label,
    nodes: model.nodes.filter(node => node.stage === stage.id).map(nodeOf),
  }))
  return { stages, unclaimed: componentPaths.filter(path => !claimed.has(path)) }
}
