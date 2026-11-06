export const REPEAT_JACCARD = 0.4

const STILL_OPEN = /^still open\b/
const NOTE = /^(?:(?:earlier|review) )?(?:(?:verification|environment|design) )?notes?\b/
const WORD = /[\p{L}\p{N}_]+/gu

function plainWords(finding: string): string[] {
  return finding.toLowerCase().match(WORD) ?? []
}

function opening(finding: string): string {
  return plainWords(finding).slice(0, 3).join(' ')
}

export function isNote(finding: string): boolean {
  return NOTE.test(opening(finding))
}

export function jaccard(one: string, other: string): number {
  const left = new Set(plainWords(one))
  const right = new Set(plainWords(other))
  const shared = [...left].filter(word => right.has(word)).length
  const all = left.size + right.size - shared
  return all === 0 ? 0 : shared / all
}

function withoutNotes(findings: readonly string[]): string[] {
  return findings.filter(finding => !isNote(finding))
}

function repeatsOneOf(finding: string, earlier: readonly string[]): boolean {
  return STILL_OPEN.test(opening(finding)) || earlier.some(each => jaccard(finding, each) >= REPEAT_JACCARD)
}

export function allFindingsRepeat(findings: readonly string[], earlierRounds: readonly (readonly string[])[]): boolean {
  const round = withoutNotes(findings)
  const earlier = withoutNotes(earlierRounds.flat())
  return round.length > 0 && earlier.length > 0 && round.every(finding => repeatsOneOf(finding, earlier))
}
