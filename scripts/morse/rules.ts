export type FileStatus = 'A' | 'M' | 'D'

export interface ChangedFile {
  path: string
  status: FileStatus
  additions: number | null
  deletions: number | null
}

export type Kind = 'instructions' | 'test' | 'src' | 'docs' | 'other'

export type Verdict = 'ladder' | 'cheap'

export interface Prediction {
  verdict: Verdict
  rule: string
  why: string[]
}

export interface Rule {
  id: string
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
  if (segments.includes('tests'))
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

function testShrunk(file: ChangedFile): boolean {
  if (kindOf(file.path) !== 'test')
    return false
  if (file.status === 'D')
    return true
  if (file.deletions === null)
    return true
  return file.deletions > 0
}

export const RULES: Rule[] = [
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
      const matches = files.filter(testShrunk)
      return matches.length > 0 ? sortedPaths(matches) : null
    },
  },
  {
    id: 'src',
    verdict: 'ladder',
    fires: (files) => {
      const matches = files.filter(file => kindOf(file.path) === 'src')
      return matches.length > 0 ? sortedPaths(matches) : null
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
      const matches = files.filter(file => kindOf(file.path) !== 'docs')
      return matches.length > 0 ? sortedPaths(matches) : null
    },
  },
]

export function classify(files: ChangedFile[], rules: Rule[] = RULES): Prediction {
  if (files.length === 0)
    throw new MorseRefusal('the diff is empty')

  for (const rule of rules) {
    const why = rule.fires(files)
    if (why !== null)
      return { verdict: rule.verdict, rule: rule.id, why }
  }

  throw new MorseRefusal('no rule decided the diff')
}
