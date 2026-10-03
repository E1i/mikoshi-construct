export const VERIFICATION_WORDS = ['measurement', 'code-reading', 'run', 'review', 'mutation', 'browser', 'human-gate'] as const

const WITNESS_COMMAND = /— witness:\s*`([^`]+)`/g
const BROWSER_WITNESS_CARRIER = /\bbrowser-witness\.mjs\b/

export function callsBrowserWitness(briefText: string): boolean {
  return [...briefText.matchAll(WITNESS_COMMAND)].some(match => BROWSER_WITNESS_CARRIER.test(match[1]!))
}
