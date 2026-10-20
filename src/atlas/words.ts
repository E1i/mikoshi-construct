import type { AbilityFinding, AbilityReason, AbilityStatus } from '../model/ability.js'

const STATUS_WORDS: Record<AbilityStatus, string> = {
  confirmed: 'confirmed',
  assumption: 'assumption',
  unknown: 'unknown',
}

const REASON_WORDS: Record<AbilityReason, string> = {
  'absent': 'absent',
  'not-run': 'not run',
  'confirmed-elsewhere': 'confirmed elsewhere',
  'written-in-repo': 'written in the repository',
}

export function abilityWords(finding: AbilityFinding): string {
  return finding.status === 'confirmed' ? STATUS_WORDS.confirmed : `${STATUS_WORDS[finding.status]} — ${REASON_WORDS[finding.reason]}`
}
