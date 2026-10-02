import type { Citation } from './functions.js'
import type { MapRow } from './map.js'
import type { Tree } from './tree.js'
import { isParseable, parse, testTitles } from './syntax.js'
import { isTestPath, reaches } from './wiring.js'

const PATH_LINE = /^(.+):([1-9]\d*)$/

export interface Evidence {
  problems: string[]
  citations: Citation[]
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

function rowProblems(tree: Tree, row: MapRow): Evidence {
  const problems: string[] = []
  const citations: Citation[] = []
  if (row.code.length === 0)
    problems.push('no code cited')
  if (row.tests.length === 0)
    problems.push('no test cited')
  for (const entry of row.code) {
    const resolved = resolve(tree, entry)
    if (resolved === 'not-a-path-line')
      problems.push(`${entry} is not a path:line`)
    else if (resolved === undefined)
      problems.push(`${entry} does not resolve to a line in the tree`)
    else
      citations.push(resolved)
  }
  const codeFiles = [...new Set(citations.map(citation => citation.file))]
  for (const { file, title } of row.tests) {
    if (!tree.files.has(file) || !isTestPath(file) || !isParseable(file)) {
      problems.push(`${file} is not a test file in the tree`)
      continue
    }
    const text = tree.read(file)
    if (!testTitles(parse(file, text)).includes(title))
      problems.push(`${file} has no it or test titled ${JSON.stringify(title)}`)
    if (codeFiles.length > 0 && !codeFiles.includes(file) && !codeFiles.some(target => reaches(file, text, target)))
      problems.push(`${file} does not reach ${codeFiles.join(', ')}`)
  }
  return { problems: problems.map(problem => `${row.id}: ${problem}`), citations }
}

export function checkEvidence(tree: Tree, requirements: string[], rows: MapRow[]): Evidence {
  const problems: string[] = []
  const citations: Citation[] = []
  for (const id of requirements) {
    const row = rows.find(candidate => candidate.id === id)
    if (row === undefined) {
      problems.push(`${id}: no evidence in the map`)
      continue
    }
    const found = rowProblems(tree, row)
    problems.push(...found.problems)
    citations.push(...found.citations)
  }
  for (const row of rows.filter(candidate => !requirements.includes(candidate.id)))
    problems.push(`${row.id}: the brief has no such requirement`)
  return { problems, citations }
}
