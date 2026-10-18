import { riskOf } from '../../src/card/risk.js'

export type FileStatus = 'A' | 'M' | 'D'

export const TOUCHED = 'touch'

export interface ChangedFile {
  path: string
  status: FileStatus | typeof TOUCHED
  additions: number | null
  deletions: number | null
}

export type Kind = 'instructions' | 'test' | 'src' | 'docs' | 'other'

export type Verdict = 'ladder' | 'cheap'

export interface Prediction {
  verdict: Verdict
  rule: RuleId
  why: string[]
}

export interface Rule<Id extends string = string> {
  id: Id
  verdict: Verdict
  fires: (files: ChangedFile[]) => string[] | null
}

export class MorseRefusal extends Error {}

const INSTRUCTIONS_DIRS = ['.claude/', 'scripts/construct/', 'templates/ai/claude/']
const INSTRUCTIONS_FILES = new Set(['CLAUDE.md', 'AGENTS.md', 'architecture/security-invariants.md'])

function isInstructions(path: string): boolean {
  return INSTRUCTIONS_DIRS.some(dir => path.startsWith(dir)) || INSTRUCTIONS_FILES.has(path)
}

function isTest(path: string): boolean {
  const segments = path.split('/')
  if (segments.slice(0, -1).includes('tests'))
    return true
  if (path.startsWith('e2e/'))
    return true
  const basename = segments[segments.length - 1]
  return basename.includes('.test.') || basename.includes('.spec.')
}

function isDocs(path: string): boolean {
  if (path.startsWith('templates/'))
    return false
  if (path.startsWith('docs/'))
    return true
  return path.endsWith('.md')
}

export function kindOf(path: string): Kind {
  if (isInstructions(path))
    return 'instructions'
  if (isTest(path))
    return 'test'
  if (path.startsWith('src/'))
    return 'src'
  if (isDocs(path))
    return 'docs'
  return 'other'
}

function sortedPaths(files: ChangedFile[]): string[] {
  return files.map(file => file.path).sort()
}

const CRITICAL_RISK = 'R1'
const UNTESTED = 'no test beside'
const UNDEFINED_TASK = 'the card carries unclear: lines'

function testShrunk(file: ChangedFile): boolean {
  if (kindOf(file.path) !== 'test' || file.status === TOUCHED)
    return false
  if (file.status === 'D')
    return true
  if (file.deletions === null)
    return true
  return file.deletions > 0
}

function deletesNonTest(file: ChangedFile): boolean {
  return file.status === 'D' && kindOf(file.path) !== 'test'
}

function criticalGrounds(files: ChangedFile[]): string[] {
  return files.flatMap((file) => {
    const risk = riskOf(file.path)
    return risk.level === CRITICAL_RISK ? [`${CRITICAL_RISK} ${file.path}: ${risk.why}`] : []
  })
}

function untestedGrounds(files: ChangedFile[]): string[] {
  if (files.some(file => kindOf(file.path) === 'test'))
    return []
  return files.filter(file => kindOf(file.path) !== 'docs').map(file => `${UNTESTED}: ${file.path}`)
}

export const RULES = [
  {
    id: 'instructions',
    verdict: 'ladder',
    fires: (files) => {
      const matches = files.filter(file => kindOf(file.path) === 'instructions')
      return matches.length > 0 ? sortedPaths(matches) : null
    },
  },
  {
    id: 'tests-shrunk',
    verdict: 'ladder',
    fires: (files) => {
      if (files.some(deletesNonTest))
        return null
      const matches = files.filter(testShrunk)
      return matches.length > 0 ? sortedPaths(matches) : null
    },
  },
  {
    id: 'src',
    verdict: 'ladder',
    fires: (files) => {
      const matches = files.filter(file => kindOf(file.path) === 'src')
      const grounded = criticalGrounds(files).length + untestedGrounds(files).length > 0
      return matches.length > 0 && grounded ? sortedPaths(matches) : null
    },
  },
  {
    id: 'docs-only',
    verdict: 'cheap',
    fires: (files) => {
      const allDocs = files.every(file => kindOf(file.path) === 'docs')
      return allDocs ? sortedPaths(files) : null
    },
  },
  {
    id: 'doubt',
    verdict: 'ladder',
    fires: (files) => {
      const grounds = [...criticalGrounds(files), ...untestedGrounds(files)].sort()
      return grounds.length > 0 ? grounds : null
    },
  },
  {
    id: 'no-ground',
    verdict: 'cheap',
    fires: files => sortedPaths(files),
  },
] as const satisfies readonly Rule[]

export type RuleId = (typeof RULES)[number]['id']

export function classify(files: ChangedFile[], rules: readonly Rule<RuleId>[] = RULES): Prediction {
  if (files.length === 0)
    throw new MorseRefusal('the diff is empty')

  for (const rule of rules) {
    const why = rule.fires(files)
    if (why !== null)
      return { verdict: rule.verdict, rule: rule.id, why }
  }

  throw new MorseRefusal('no rule decided the diff')
}

export function classifyTouches(touches: readonly string[], unclear: boolean): Prediction {
  if (unclear)
    return { verdict: 'ladder', rule: 'doubt', why: [UNDEFINED_TASK] }
  return classify(touches.map(path => ({ path, status: TOUCHED, additions: null, deletions: null })))
}
