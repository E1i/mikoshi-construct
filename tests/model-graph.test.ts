import type { ModelPicture, StateSource } from '../src/model/graph.js'
import type { RepositoryModel } from '../src/model/schema.js'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { embed, extractEmbedded, PICTURE_DOC, PICTURE_DOC_PATH, renderEmbedded, REPO_ROOT, staleProblems } from '../scripts/model/render.js'
import { PICTURE_PROSE, pictureOfModel, renderModelGraph } from '../src/model/graph.js'
import { MODEL_VERSION } from '../src/model/schema.js'
import { deriveModelState } from '../src/model/state.js'
import { readModel } from '../src/model/write.js'
import { READS_AS_A_VERDICT } from './lore-vocabulary.js'

const SHARED: RepositoryModel = {
  modelVersion: MODEL_VERSION,
  facts: [
    { id: 'shared-file', kind: 'file-exists', path: 'docs/shared.md', authoredBy: 'construct' },
    { id: 'shared-file-names-the-step', kind: 'file-contains', path: 'docs/shared.md', authoredBy: 'construct', needle: 'the "step"' },
    { id: 'only-one-dependent', kind: 'file-exists', path: 'docs/alone.md', authoredBy: 'discovery' },
  ],
  claims: [
    {
      id: 'first-claim',
      statement: 'The first claim stands on the shared file',
      authoredBy: 'construct',
      enforcement: { mechanism: 'the first mechanism', level: 'L3', supportedBy: ['shared-file'] },
      verification: { mechanism: 'the first demonstration', supportedBy: ['shared-file-names-the-step'] },
    },
    {
      id: 'second-claim',
      statement: 'The second claim stands on the same shared file',
      authoredBy: 'construct',
      enforcement: { mechanism: 'the second mechanism', level: 'L1', supportedBy: ['shared-file'] },
      verification: null,
    },
  ],
  hypotheses: [
    {
      id: 'a-hypothesis',
      statement: 'Discovery concluded something the shared file carries',
      authoredBy: 'discovery',
      baseSha: null,
      evidenceClean: true,
      supportedBy: ['shared-file', 'only-one-dependent'],
    },
  ],
}

function scratch(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-graph-'))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
    writeFileSync(path.join(root, file), content)
  }
  return root
}

function mermaidOf(picture: ModelPicture): string {
  if (picture.at !== 'drawn')
    throw new Error(`the picture was ${picture.at}, so there is no diagram to read`)
  return picture.mermaid
}

function nodeLineFor(mermaid: string, needle: string): string[] {
  return mermaid.split('\n').filter(line => line.includes(needle) && !line.includes('-->'))
}

function edgeLines(mermaid: string): string[] {
  return mermaid.split('\n').filter(line => line.includes('-->')).map(line => line.trim())
}

describe('the model drawn as a graph', () => {
  const root = scratch({ 'docs/shared.md': 'the "step" is here\n' })
  const mermaid = renderModelGraph(SHARED, deriveModelState(SHARED, root))

  it('draws a fact several entries stand on once, with one edge from each dependent', () => {
    expect(nodeLineFor(mermaid, 'docs/shared.md<br/>')).toHaveLength(1)
    expect(edgeLines(mermaid).filter(line => line.endsWith('f_shared_file'))).toEqual([
      'e_first_claim -->|"enforcement"| f_shared_file',
      'e_second_claim -->|"enforcement"| f_shared_file',
      'e_a_hypothesis --> f_shared_file',
    ])
  })

  it('labels a claim\'s edges with the stage they come from, so the two lists stay apart', () => {
    expect(edgeLines(mermaid).filter(line => line.startsWith('e_first_claim'))).toEqual([
      'e_first_claim -->|"enforcement"| f_shared_file',
      'e_first_claim -->|"verification"| f_shared_file_names_the_step',
    ])
  })

  it('carries the derived state of every node, including the level the claim declares', () => {
    expect(nodeLineFor(mermaid, 'e_first_claim')[0]).toContain('enforcement L3 held<br/>verification held')
    expect(nodeLineFor(mermaid, 'e_second_claim')[0]).toContain('enforcement L1 held<br/>verification unknown, no fact named')
    expect(nodeLineFor(mermaid, 'e_a_hypothesis')[0]).toContain('a-hypothesis<br/>unsupported')
    expect(nodeLineFor(mermaid, 'f_only_one_dependent')[0]).toContain('docs/alone.md<br/>does not hold')
  })

  it('draws every entry and every fact of the model exactly once', () => {
    for (const id of ['f_shared_file', 'f_shared_file_names_the_step', 'f_only_one_dependent', 'e_first_claim', 'e_second_claim', 'e_a_hypothesis'])
      expect(nodeLineFor(mermaid, `${id}[`).length + nodeLineFor(mermaid, `${id}(`).length, id).toBe(1)
  })

  it('escapes a needle carrying a quote rather than breaking the label it sits in', () => {
    expect(mermaid).toContain('contains #quot;the #quot;step#quot;#quot;')
    expect(nodeLineFor(mermaid, 'f_shared_file_names_the_step')[0].split('"')).toHaveLength(3)
  })
})

describe('the gate against a state the renderer decides for itself', () => {
  const root = scratch({ 'docs/shared.md': 'the "step" is here\n' })
  const honest = mermaidOf(pictureOfModel(SHARED, root))

  const IMPOSTORS: Record<string, StateSource> = {
    'by how many dependents a fact carries': model => ({
      facts: Object.fromEntries(model.facts.map(fact => [fact.id, fact.id === 'shared-file' ? 'holds' : 'does-not-hold'])),
      hypotheses: Object.fromEntries(model.hypotheses.map(hypothesis => [hypothesis.id, { state: 'held' }])),
      claims: Object.fromEntries(model.claims.map(claim => [claim.id, { enforcement: { state: 'held' }, verification: { state: 'held' } }])),
    }),
    'by the level the claim declares': model => ({
      facts: Object.fromEntries(model.facts.map(fact => [fact.id, 'holds'])),
      hypotheses: Object.fromEntries(model.hypotheses.map(hypothesis => [hypothesis.id, { state: 'held' }])),
      claims: Object.fromEntries(model.claims.map(claim => [claim.id, {
        enforcement: claim.enforcement?.level === 'L3' ? { state: 'held' } : { state: 'unsupported', doesNotHold: ['invented'] },
        verification: { state: 'held' },
      }])),
    }),
    'by whether the fact names a needle at all': model => ({
      facts: Object.fromEntries(model.facts.map(fact => [fact.id, fact.needle == null ? 'holds' : 'does-not-hold'])),
      hypotheses: Object.fromEntries(model.hypotheses.map(hypothesis => [hypothesis.id, { state: 'unknown', reason: 'no-fact-named' }])),
      claims: Object.fromEntries(model.claims.map(claim => [claim.id, { enforcement: { state: 'held' }, verification: { state: 'held' } }])),
    }),
  }

  it('reads the state of the tree it was given, because deriveModelState is the only source', () => {
    expect(honest).toBe(renderModelGraph(SHARED, deriveModelState(SHARED, root)))
    expect(honest).toContain('docs/alone.md<br/>does not hold')
  })

  for (const [derivation, impostor] of Object.entries(IMPOSTORS)) {
    it(`fails on a renderer deciding a state ${derivation}`, () => {
      expect(mermaidOf(pictureOfModel(SHARED, root, impostor))).not.toBe(honest)
    })
  }
})

describe('a repository with no model of its own', () => {
  const empty: RepositoryModel = { modelVersion: MODEL_VERSION, facts: [], claims: [], hypotheses: [] }

  it('says there is no construct.model.json and draws nothing at all', () => {
    const picture = pictureOfModel(null, scratch())
    expect(picture).toEqual({ at: 'no-model' })
    expect(renderEmbedded(picture)).not.toContain('```mermaid')
    expect(renderEmbedded(picture)).toContain('There is no construct.model.json here')
  })

  it('separates a model that parses and carries no entry from no model at all', () => {
    expect(pictureOfModel(empty, scratch())).toEqual({ at: 'no-entry' })
    expect(renderEmbedded(pictureOfModel(empty, scratch()))).not.toContain('```mermaid')
    expect(renderEmbedded(pictureOfModel(empty, scratch()))).not.toBe(renderEmbedded(pictureOfModel(null, scratch())))
  })

  it('reads the absence off the repository rather than off a model handed to it', () => {
    expect(pictureOfModel(readModel(scratch()), scratch())).toEqual({ at: 'no-model' })
  })
})

describe('the rendering states what is held and pronounces on nothing else', () => {
  it('carries no word in its own prose, labels or legend that reads as refutation or as proof', () => {
    for (const picture of [pictureOfModel(SHARED, scratch()), pictureOfModel(null, scratch()), pictureOfModel({ modelVersion: MODEL_VERSION, facts: [], claims: [], hypotheses: [] }, scratch())])
      expect(READS_AS_A_VERDICT.test(renderEmbedded(picture)), renderEmbedded(picture)).toBe(false)
  })

  it('holds the three readings apart in three sentences, none of which is an empty diagram', () => {
    expect(new Set(Object.values(PICTURE_PROSE)).size).toBe(3)
    for (const prose of Object.values(PICTURE_PROSE))
      expect(READS_AS_A_VERDICT.test(prose), prose).toBe(false)
  })
})

describe('this repository\'s own picture is committed and checked', () => {
  const doc = readFileSync(PICTURE_DOC_PATH, 'utf8')
  const picture = pictureOfModel(readModel(REPO_ROOT), REPO_ROOT)

  it('carries the rendering of the model as it stands, so the committed block is current', () => {
    expect(picture.at).toBe('drawn')
    expect(extractEmbedded(doc, PICTURE_DOC)).toContain('```mermaid')
    expect(staleProblems(doc, picture, PICTURE_DOC)).toEqual([])
  })

  it('reports the block as stale when the committed markdown is edited away from the model', () => {
    const edited = doc.replace('flowchart LR', 'flowchart TB')
    expect(edited).not.toBe(doc)
    expect(staleProblems(edited, picture, PICTURE_DOC)).toEqual([`${PICTURE_DOC}: the picture of construct.model.json is out of date; run pnpm model:render`])
  })

  it('reports the block as stale when the model gains an entry and nothing is rendered again', () => {
    const model = readModel(REPO_ROOT)
    if (model == null)
      throw new Error('this repository carries a construct.model.json')
    const grown = pictureOfModel({ ...model, hypotheses: [...model.hypotheses, SHARED.hypotheses[0]], facts: [...model.facts, SHARED.facts[0], SHARED.facts[2]] }, REPO_ROOT)
    expect(staleProblems(doc, grown, PICTURE_DOC)).toHaveLength(1)
    expect(staleProblems(embed(doc, grown, PICTURE_DOC), grown, PICTURE_DOC)).toEqual([])
  })

  it('runs that check inside the harness, so a model change that lands unrendered turns it red', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(manifest.scripts['model:check']).toBe('tsx scripts/model/check.ts')
    expect(manifest.scripts.quality).toContain('pnpm model:check')
  })
})
