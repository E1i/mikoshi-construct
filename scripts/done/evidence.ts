import type { Citation } from './functions.js'
import type { MapRow, MapTest } from './map.js'
import type { Brief } from './requirements.js'
import type { Tree } from './tree.js'
import { createHash } from 'node:crypto'
import { isWitnessEntry } from './map.js'
import { isParseable, parse, testTitles } from './syntax.js'
import { isSource, isTestPath, reaches } from './wiring.js'

const PATH_LINE = /^(.+):([1-9]\d*)$/
const WITNESS_ID = /^W([1-9]\d*)$/

export interface TextOnlyRow {
  id: string
  code: string[]
}

export interface Evidence {
  problems: string[]
  citations: Citation[]
  textOnly: TextOnlyRow[]
}

function resolve(tree: Tree, entry: string): Citation | 'not-a-path-line' | undefined {
  const match = PATH_LINE.exec(entry)
  if (match === null)
    return 'not-a-path-line'
  const file = match[1]!
  const line = Number(match[2])
  if (!tree.files.has(file))
    return undefined
  const text = tree.read(file).split('\n')[line - 1]
  return text === undefined || text.trim() === '' ? undefined : { file, line }
}

function witnessProblem(brief: Brief, witness: string): string | undefined {
  const index = Number(WITNESS_ID.exec(witness)?.[1] ?? 0)
  if (index < 1 || index > brief.witnesses.length)
    return `${witness} is not a witness of the brief`
  const { criterion, command } = brief.witnesses[index - 1]!
  const digest = brief.witnessDigests.find(candidate => candidate.criterion === criterion)
  if (digest?.sha256 !== createHash('sha256').update(command).digest('hex'))
    return `${witness} does not match its digest`
  return undefined
}

function testProblems(tree: Tree, codeFiles: string[], { file, title }: MapTest): string[] {
  if (!tree.files.has(file) || !isTestPath(file) || !isParseable(file))
    return [`${file} is not a test file in the tree`]
  const problems: string[] = []
  const text = tree.read(file)
  if (!testTitles(parse(file, text)).includes(title))
    problems.push(`${file} has no it or test titled ${JSON.stringify(title)}`)
  if (codeFiles.length > 0 && !codeFiles.includes(file) && !codeFiles.some(target => reaches(file, text, target)))
    problems.push(`${file} does not reach ${codeFiles.join(', ')}`)
  return problems
}

function rowEvidence(tree: Tree, brief: Brief, row: MapRow): Evidence {
  const codeProblems: string[] = []
  const citations: Citation[] = []
  for (const entry of row.code) {
    const resolved = resolve(tree, entry)
    if (resolved === 'not-a-path-line')
      codeProblems.push(`${entry} is not a path:line`)
    else if (resolved === undefined)
      codeProblems.push(`${entry} does not resolve to a line in the tree`)
    else
      citations.push(resolved)
  }
  const heldByText = row.code.length > 0 && citations.length === row.code.length && citations.every(citation => !isSource(citation.file))
  const codeFiles = [...new Set(citations.map(citation => citation.file))]
  const problems = [
    ...(row.code.length === 0 ? ['no code cited'] : []),
    ...(row.tests.length === 0 && !heldByText ? ['no test cited'] : []),
    ...codeProblems,
    ...row.tests.flatMap(entry => isWitnessEntry(entry) ? (witnessProblem(brief, entry.witness) ?? []) : testProblems(tree, codeFiles, entry)),
  ]
  const textOnly = heldByText && row.tests.length === 0 ? [{ id: row.id, code: row.code }] : []
  return { problems: problems.map(problem => `${row.id}: ${problem}`), citations, textOnly }
}

export function checkEvidence(tree: Tree, brief: Brief, rows: MapRow[]): Evidence {
  const problems: string[] = []
  const citations: Citation[] = []
  const textOnly: TextOnlyRow[] = []
  for (const id of brief.requirements) {
    const row = rows.find(candidate => candidate.id === id)
    if (row === undefined) {
      problems.push(`${id}: no evidence in the map`)
      continue
    }
    const found = rowEvidence(tree, brief, row)
    problems.push(...found.problems)
    citations.push(...found.citations)
    textOnly.push(...found.textOnly)
  }
  for (const row of rows.filter(candidate => !brief.requirements.includes(candidate.id)))
    problems.push(`${row.id}: the brief has no such requirement`)
  return { problems, citations, textOnly }
}
