import path from 'node:path'
import { SANDBOX_FAILING_LIST } from '../../ci/sandbox-failing.js'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..')
const TEST_KEYED_RECORDS: ReadonlySet<string> = new Set([path.relative(REPOSITORY_ROOT, SANDBOX_FAILING_LIST)])
export const CONCEPT_WIDENING_REASON = 'within the card\'s concept under a window shard (D-360): a direct importer of a touched file, a file under a test root or a test-keyed record'

export interface CardConcept {
  touches: readonly string[]
  creates: readonly string[]
  ownerPath: (file: string) => boolean
}

export interface ConceptRules {
  reaches: (file: string, concept: CardConcept) => boolean
  neverFollows: (file: string, concept: CardConcept) => boolean
  testRoots: readonly string[]
}

export interface ConceptWidening {
  widened: string[]
  outside: string[]
}

export type Importers = ReadonlyMap<string, readonly string[]>

function importsATouch(file: string, concept: CardConcept, rules: ConceptRules, importers: Importers): boolean {
  return [...importers].some(([target, files]) => rules.reaches(target, concept) && files.includes(file))
}

function guarded(file: string, concept: CardConcept, rules: ConceptRules): boolean {
  return concept.ownerPath(file) || rules.neverFollows(file, concept)
}

function underATestRoot(file: string, rules: ConceptRules): boolean {
  return rules.testRoots.some(root => file.startsWith(`${root}/`))
}

function withinTheConcept(file: string, concept: CardConcept, rules: ConceptRules, importers: Importers): boolean {
  return !guarded(file, concept, rules) && (underATestRoot(file, rules) || TEST_KEYED_RECORDS.has(file) || importsATouch(file, concept, rules, importers))
}

export function conceptWidening(outside: readonly string[], concept: CardConcept, rules: ConceptRules, importers: () => Importers): ConceptWidening {
  if (outside.length === 0)
    return { widened: [], outside: [] }
  const known = importers()
  const within = (file: string): boolean => withinTheConcept(file, concept, rules, known)
  return { widened: outside.filter(within), outside: outside.filter(file => !within(file)) }
}
