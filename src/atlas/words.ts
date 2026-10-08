import type { AbilityFinding, AbilityReason, AbilityStatus } from '../model/ability.js'
import type { Component, ComponentReason } from '../model/schema.js'

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

const COMPONENT_REASON_WORDS: Record<ComponentReason, string> = {
  'type-not-scanned': 'discovery reads no file of this type',
  'unreadable': 'the file could not be read',
}

export function abilityWords(finding: AbilityFinding): string {
  return finding.status === 'confirmed' ? STATUS_WORDS.confirmed : `${STATUS_WORDS[finding.status]} — ${REASON_WORDS[finding.reason]}`
}

export function componentWords(component: Component): string | null {
  return component.relations === 'found' ? null : `relations unknown — ${COMPONENT_REASON_WORDS[component.reason]}`
}
