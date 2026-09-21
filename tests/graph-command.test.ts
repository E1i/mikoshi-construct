import type { StateSource } from '../src/model/graph.js'
import type { RepositoryModel } from '../src/model/schema.js'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractEmbedded, PICTURE_DOC, PICTURE_DOC_PATH, REPO_ROOT } from '../scripts/model/render.js'
import { modelPicture, printGraph } from '../src/commands/graph.js'
import { pictureOfModel } from '../src/model/graph.js'
import { MODEL_VERSION } from '../src/model/schema.js'
import { readModel, writeModel } from '../src/model/write.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { IN_UNIVERSE, READS_AS_A_VERDICT } from './lore-vocabulary.js'

const MODEL: RepositoryModel = {
  modelVersion: MODEL_VERSION,
  facts: [
    { id: 'present-file', kind: 'file-exists', path: 'docs/present.md', authoredBy: 'construct' },
    { id: 'present-file-names-the-step', kind: 'file-contains', path: 'docs/present.md', authoredBy: 'construct', needle: 'the step' },
    { id: 'absent-file', kind: 'file-exists', path: 'docs/absent.md', authoredBy: 'discovery' },
  ],
  claims: [
    {
      id: 'a-claim',
      statement: 'The claim stands on the file that is here',
      authoredBy: 'construct',
      enforcement: { mechanism: 'the mechanism', level: 'L3', supportedBy: ['present-file'] },
      verification: { mechanism: 'the demonstration', supportedBy: ['present-file-names-the-step'] },
    },
  ],
  hypotheses: [
    {
      id: 'a-hypothesis',
      statement: 'Discovery concluded something the absent file would carry',
      authoredBy: 'discovery',
      baseSha: null,
      evidenceClean: true,
      supportedBy: ['absent-file'],
    },
  ],
}

const EMPTY: RepositoryModel = { modelVersion: MODEL_VERSION, facts: [], claims: [], hypotheses: [] }

const EVERY_STATE_HELD: StateSource = model => ({
  facts: Object.fromEntries(model.facts.map(fact => [fact.id, 'holds'])),
  hypotheses: Object.fromEntries(model.hypotheses.map(hypothesis => [hypothesis.id, { state: 'held' }])),
  claims: Object.fromEntries(model.claims.map(claim => [claim.id, { enforcement: { state: 'held' }, verification: { state: 'held' } }])),
})

function scratch(model: RepositoryModel | null, files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-graph-command-'))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
    writeFileSync(path.join(root, file), content)
  }
  if (model != null)
    writeModel(root, model)
  return root
}

function drawn(): string {
  return scratch(MODEL, { 'docs/present.md': 'the step is here\n' })
}

function run(dir: string, theme: Parameters<typeof resolveTheme>[0] = { plain: true }, states?: StateSource): { exit: number, stdout: string, stderr: string } {
  const stdout: string[] = []
  const stderr: string[] = []
  const ui = createUi(resolveTheme(theme), text => stderr.push(text))
  const picture = states == null ? modelPicture(dir) : modelPicture(dir, states)
  const exit = printGraph(ui, picture, text => stdout.push(text))
  return { exit, stdout: stdout.join(''), stderr: stderr.join('') }
}

function sourceFiles(directory: string, prefix: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}/${entry.name}`
    if (entry.isDirectory())
      return sourceFiles(path.join(directory, entry.name), relative)
    return entry.isFile() && entry.name.endsWith('.ts') ? [relative] : []
  })
}

describe('construct graph draws the model of the directory it is given', () => {
  it('writes the Mermaid of that directory\'s model to stdout, and says nothing on stderr', () => {
    const { exit, stdout, stderr } = run(drawn())
    expect(exit).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.startsWith('flowchart LR')).toBe(true)
    expect(stdout).toContain('a-claim<br/>enforcement L3 held')
  })

  it('renders through pictureOfModel, so the command carries no drawing of its own', () => {
    const root = drawn()
    const picture = pictureOfModel(readModel(root), root)
    if (picture.at !== 'drawn')
      throw new Error(`the picture was ${picture.at}, so there is no diagram to compare`)
    expect(run(root).stdout).toBe(picture.mermaid)
  })

  it('reads the model of the directory it is given rather than the one it runs in', () => {
    expect(run(REPO_ROOT).stdout).not.toBe(run(drawn()).stdout)
  })
})

describe('one renderer, reached by the command and by the script that embeds the picture', () => {
  it('draws this repository exactly as the committed block the embedding script wrote', () => {
    const { stdout } = run(REPO_ROOT)
    expect(stdout).not.toBe('')
    expect(extractEmbedded(readFileSync(PICTURE_DOC_PATH, 'utf8'), PICTURE_DOC)).toContain(stdout)
  })

  it('names no second rendering path: renderModelGraph is called from the one module that owns it', () => {
    const sources = [...sourceFiles(path.join(REPO_ROOT, 'src'), 'src'), ...sourceFiles(path.join(REPO_ROOT, 'scripts'), 'scripts')]
    expect(sources.length).toBeGreaterThan(20)
    expect(sources.filter(source => readFileSync(path.join(REPO_ROOT, source), 'utf8').includes('renderModelGraph'))).toEqual(['src/model/graph.ts'])
  })
})

describe('no model is not an empty model, and neither is a failure', () => {
  it('draws nothing and says there is no construct.model.json, on stderr and with exit 0', () => {
    const { exit, stdout, stderr } = run(scratch(null))
    expect(exit).toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toContain('There is no construct.model.json here')
  })

  it('says something else again for a model that parses and carries no entry, also on stderr and also exit 0', () => {
    const { exit, stdout, stderr } = run(scratch(EMPTY))
    expect(exit).toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toContain('names no fact, claim or hypothesis')
    expect(stderr).not.toBe(run(scratch(null)).stderr)
  })
})

describe('the states shown are derived, and the command decides none of them', () => {
  it('fails on a command deciding for itself that every entry is held', () => {
    const root = drawn()
    expect(run(root, { plain: true }, EVERY_STATE_HELD).stdout).not.toBe(run(root).stdout)
  })

  it('carries the derived state of the tree it was given, including a fact that is not there', () => {
    expect(run(drawn()).stdout).toContain('docs/absent.md<br/>does not hold')
  })
})

describe('the picture states what is held and pronounces on nothing else', () => {
  for (const theme of [{ plain: true }, { plain: false }]) {
    it(`carries no label, legend or prose reading as refutation or as proof in the ${theme.plain ? 'plain' : 'lore'} register`, () => {
      for (const root of [drawn(), scratch(null), scratch(EMPTY)]) {
        const { stdout, stderr } = run(root, theme)
        expect(READS_AS_A_VERDICT.test(stdout + stderr), stdout + stderr).toBe(false)
      }
    })
  }

  it('carries no emoji and no lore vocabulary with --plain', () => {
    for (const root of [drawn(), scratch(null), scratch(EMPTY)]) {
      const { stdout, stderr } = run(root)
      expect(stdout + stderr).not.toMatch(/\p{Extended_Pictographic}/u)
      for (const word of IN_UNIVERSE)
        expect((stdout + stderr).toUpperCase(), word).not.toContain(word.toUpperCase())
    }
  })
})
