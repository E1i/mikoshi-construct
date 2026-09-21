import type { Claim, Fact, Hypothesis, RepositoryModel } from './schema.js'
import type { ClaimStages, FactEvaluation, ModelStateReport, StageFinding } from './state.js'
import { CHAIN_STAGES } from './path.js'
import { deriveModelState } from './state.js'

export const PICTURE_READINGS = ['drawn', 'no-entry', 'no-model'] as const
export type PictureReading = (typeof PICTURE_READINGS)[number]

export type ModelPicture
  = | { at: 'drawn', mermaid: string }
    | { at: Exclude<PictureReading, 'drawn'> }

export type StateSource = (model: RepositoryModel, root: string) => ModelStateReport

export const PICTURE_PROSE: Record<PictureReading, string> = {
  'drawn': 'What this tool holds about the repository, and the files each reading stands on. A fact several entries stand on is drawn once, with one edge from each of them. Every state below is derived on read, never stored.',
  'no-entry': 'There is a construct.model.json here and it names no fact, claim or hypothesis, so there is nothing to draw yet.',
  'no-model': 'There is no construct.model.json here. Nothing was read, so there is nothing to draw: this is what absence looks like, not an empty diagram.',
}

const FACT_WORDS: Record<FactEvaluation, string> = {
  'holds': 'holds',
  'does-not-hold': 'does not hold',
  'unevaluable': 'unevaluable',
}

const NOTHING_NAMED: StageFinding = { state: 'unknown', reason: 'no-fact-named' }

export const PICTURE_NODE_KINDS = ['claim', 'hypothesis', 'fact'] as const
export type PictureNodeKind = (typeof PICTURE_NODE_KINDS)[number]

export const PICTURE_STATES = ['held', 'unsupported', 'unknown'] as const
export type PictureState = (typeof PICTURE_STATES)[number]

export interface PictureNode {
  id: string
  entryId: string
  kind: PictureNodeKind
  lines: [string, ...string[]]
  state: PictureState
}

export interface PictureEdge {
  from: string
  to: string
  stage: string | null
}

export interface ModelGraph {
  nodes: PictureNode[]
  edges: PictureEdge[]
}

const FACT_STATES: Record<FactEvaluation, PictureState> = {
  'holds': 'held',
  'does-not-hold': 'unsupported',
  'unevaluable': 'unknown',
}

function quoted(label: string): string {
  return `"${label.replaceAll('"', '#quot;')}"`
}

function mermaidIds(prefix: string, ids: string[]): Map<string, string> {
  const taken = new Set<string>()
  return new Map(ids.map((id) => {
    const base = `${prefix}_${id.replaceAll(/\W/g, '_')}`
    let candidate = base
    let suffix = 2
    while (taken.has(candidate)) {
      candidate = `${base}_${suffix}`
      suffix += 1
    }
    taken.add(candidate)
    return [id, candidate]
  }))
}

function stageWord(finding: StageFinding): string {
  if (finding.state === 'unknown')
    return finding.reason === 'no-fact-named' ? 'unknown, no fact named' : 'unknown, a fact could not be read'
  return finding.state
}

function claimLines(claim: Claim, stages: ClaimStages): [string, ...string[]] {
  const level = claim.enforcement == null ? '' : `${claim.enforcement.level} `
  return [claim.id, `enforcement ${level}${stageWord(stages.enforcement)}`, `verification ${stageWord(stages.verification)}`]
}

function hypothesisLines(hypothesis: Hypothesis, finding: StageFinding): [string, ...string[]] {
  return [hypothesis.id, stageWord(finding)]
}

function factLines(fact: Fact, evaluation: FactEvaluation): [string, ...string[]] {
  const needle = fact.needle == null ? '' : ` contains "${fact.needle}"`
  return [`${fact.path}${needle}`, FACT_WORDS[evaluation]]
}

function worstOf(states: PictureState[]): PictureState {
  if (states.includes('unsupported'))
    return 'unsupported'
  return states.includes('unknown') ? 'unknown' : 'held'
}

export function graphOfModel(model: RepositoryModel, derived: ModelStateReport): ModelGraph {
  const entries = mermaidIds('e', [...model.claims.map(claim => claim.id), ...model.hypotheses.map(hypothesis => hypothesis.id)])
  const facts = mermaidIds('f', model.facts.map(fact => fact.id))
  const stagesOf = (claim: Claim): ClaimStages => derived.claims[claim.id] ?? { enforcement: NOTHING_NAMED, verification: NOTHING_NAMED }

  const nodes: PictureNode[] = [
    ...model.claims.map((claim): PictureNode => ({
      id: entries.get(claim.id) ?? claim.id,
      entryId: claim.id,
      kind: 'claim',
      lines: claimLines(claim, stagesOf(claim)),
      state: worstOf([stagesOf(claim).enforcement.state, stagesOf(claim).verification.state]),
    })),
    ...model.hypotheses.map((hypothesis): PictureNode => ({
      id: entries.get(hypothesis.id) ?? hypothesis.id,
      entryId: hypothesis.id,
      kind: 'hypothesis',
      lines: hypothesisLines(hypothesis, derived.hypotheses[hypothesis.id] ?? NOTHING_NAMED),
      state: (derived.hypotheses[hypothesis.id] ?? NOTHING_NAMED).state,
    })),
    ...model.facts.map((fact): PictureNode => ({
      id: facts.get(fact.id) ?? fact.id,
      entryId: fact.id,
      kind: 'fact',
      lines: factLines(fact, derived.facts[fact.id] ?? 'unevaluable'),
      state: FACT_STATES[derived.facts[fact.id] ?? 'unevaluable'],
    })),
  ]

  const edges: PictureEdge[] = [
    ...model.claims.flatMap(claim => CHAIN_STAGES.flatMap(stage => (claim[stage]?.supportedBy ?? []).map(
      (factId): PictureEdge => ({ from: entries.get(claim.id) ?? claim.id, to: facts.get(factId) ?? factId, stage }),
    ))),
    ...model.hypotheses.flatMap(hypothesis => hypothesis.supportedBy.map(
      (factId): PictureEdge => ({ from: entries.get(hypothesis.id) ?? hypothesis.id, to: facts.get(factId) ?? factId, stage: null }),
    )),
  ]

  return { nodes, edges }
}

const MERMAID_SHAPES: Record<PictureNodeKind, [string, string]> = {
  claim: ['[', ']'],
  hypothesis: ['(', ')'],
  fact: ['[/', '/]'],
}

const MERMAID_GROUPS: [PictureNodeKind, string][] = [['claim', 'Claims'], ['hypothesis', 'Hypotheses'], ['fact', 'Evidence']]

function group(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : [`  subgraph ${title.toLowerCase()}[${quoted(title)}]`, ...lines, '  end']
}

function mermaidNode(node: PictureNode): string {
  const [open, close] = MERMAID_SHAPES[node.kind]
  return `    ${node.id}${open}${quoted(node.lines.join('<br/>'))}${close}`
}

function mermaidEdge(edge: PictureEdge): string {
  const arrow = edge.stage == null ? '-->' : `-->|${quoted(edge.stage)}|`
  return `  ${edge.from} ${arrow} ${edge.to}`
}

export function mermaidFromGraph(graph: ModelGraph): string {
  return `${[
    'flowchart LR',
    ...MERMAID_GROUPS.flatMap(([kind, title]) => group(title, graph.nodes.filter(node => node.kind === kind).map(mermaidNode))),
    ...graph.edges.map(mermaidEdge),
  ].join('\n')}\n`
}

export function renderModelGraph(model: RepositoryModel, derived: ModelStateReport): string {
  return mermaidFromGraph(graphOfModel(model, derived))
}

export function pictureOfModel(model: RepositoryModel | null, root: string, states: StateSource = deriveModelState): ModelPicture {
  if (model == null)
    return { at: 'no-model' }
  if (model.facts.length === 0 && model.claims.length === 0 && model.hypotheses.length === 0)
    return { at: 'no-entry' }
  return { at: 'drawn', mermaid: renderModelGraph(model, states(model, root)) }
}
