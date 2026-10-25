export const VOCABULARY = [
  'need code change',
  'need test report',
  'need base replay',
  'need mutation',
  'need generated artifact',
  'need contract diff',
  'need brief parsing',
  'need judgement',
  'need transcript inspection',
  'need environment matrix',
  'need live CI observation',
  'need remote status observation',
  'need registry observation',
  'need merge',
  'need human gate',
  'need byte-exact transfer',
  'need ledger join',
  'need isolated workspace',
  'need settings read',
  'need shared state write',
  'need tracker write',
  'need witness validation',
] as const

export type Capability = typeof VOCABULARY[number]

export function sortByVocabulary(capabilities: Capability[]): Capability[] {
  const unique = [...new Set(capabilities)]
  return unique.sort((a, b) => VOCABULARY.indexOf(a) - VOCABULARY.indexOf(b))
}

const CONTRACT_SURFACE_PATH = 'contract/surface.json'
const WORKFLOWS_PREFIX = '.github/workflows/'
const MATERIALIZE_PREFIX = 'src/materialize/'

export function pathTriggeredCapabilities(writePaths: string[]): Capability[] {
  const capabilities: Capability[] = []
  if (writePaths.includes(CONTRACT_SURFACE_PATH)) {
    capabilities.push('need generated artifact', 'need contract diff')
  }
  if (writePaths.some(path => path.startsWith(WORKFLOWS_PREFIX))) {
    capabilities.push('need live CI observation')
  }
  if (writePaths.some(path => path.startsWith(MATERIALIZE_PREFIX))) {
    capabilities.push('need environment matrix')
  }
  return capabilities
}

export function executorCapabilities(executor: 'ladder' | 'direct'): Capability[] {
  return executor === 'ladder'
    ? ['need code change', 'need brief parsing', 'need merge', 'need isolated workspace']
    : ['need merge']
}
