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

function claimLabel(claim: Claim, stages: ClaimStages): string {
  const level = claim.enforcement == null ? '' : `${claim.enforcement.level} `
  return `${claim.id}<br/>enforcement ${level}${stageWord(stages.enforcement)}<br/>verification ${stageWord(stages.verification)}`
}

function hypothesisLabel(hypothesis: Hypothesis, finding: StageFinding): string {
  return `${hypothesis.id}<br/>${stageWord(finding)}`
}

function factLabel(fact: Fact, evaluation: FactEvaluation): string {
  const needle = fact.needle == null ? '' : ` contains "${fact.needle}"`
  return `${fact.path}${needle}<br/>${FACT_WORDS[evaluation]}`
}

function group(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : [`  subgraph ${title.toLowerCase()}[${quoted(title)}]`, ...lines, '  end']
}

export function renderModelGraph(model: RepositoryModel, derived: ModelStateReport): string {
  const entries = mermaidIds('e', [...model.claims.map(claim => claim.id), ...model.hypotheses.map(hypothesis => hypothesis.id)])
  const facts = mermaidIds('f', model.facts.map(fact => fact.id))
  const claimNodes = model.claims.map(claim => `    ${entries.get(claim.id)}[${quoted(claimLabel(claim, derived.claims[claim.id] ?? { enforcement: NOTHING_NAMED, verification: NOTHING_NAMED }))}]`)
  const hypothesisNodes = model.hypotheses.map(hypothesis => `    ${entries.get(hypothesis.id)}(${quoted(hypothesisLabel(hypothesis, derived.hypotheses[hypothesis.id] ?? NOTHING_NAMED))})`)
  const factNodes = model.facts.map(fact => `    ${facts.get(fact.id)}[/${quoted(factLabel(fact, derived.facts[fact.id] ?? 'unevaluable'))}/]`)
  const edges = [
    ...model.claims.flatMap(claim => CHAIN_STAGES.flatMap(stage => (claim[stage]?.supportedBy ?? []).map(
      factId => `  ${entries.get(claim.id)} -->|${quoted(stage)}| ${facts.get(factId)}`,
    ))),
    ...model.hypotheses.flatMap(hypothesis => hypothesis.supportedBy.map(
      factId => `  ${entries.get(hypothesis.id)} --> ${facts.get(factId)}`,
    )),
  ]
  return `${[
    'flowchart LR',
    ...group('Claims', claimNodes),
    ...group('Hypotheses', hypothesisNodes),
    ...group('Evidence', factNodes),
    ...edges,
  ].join('\n')}\n`
}

export function pictureOfModel(model: RepositoryModel | null, root: string, states: StateSource = deriveModelState): ModelPicture {
  if (model == null)
    return { at: 'no-model' }
  if (model.facts.length === 0 && model.claims.length === 0 && model.hypotheses.length === 0)
    return { at: 'no-entry' }
  return { at: 'drawn', mermaid: renderModelGraph(model, states(model, root)) }
}
