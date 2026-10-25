export interface HandoffField {
  id: string
  label: string
  group: 'where we are' | 'what continuing needs' | 'how to verify' | 'what must not be lost'
}

export const HANDOFF_FIELDS: readonly HandoffField[] = [
  { id: 'current-card', label: 'current card', group: 'where we are' },
  { id: 'queue', label: 'queue', group: 'where we are' },
  { id: 'done', label: 'done', group: 'where we are' },
  { id: 'not-done', label: 'not done', group: 'where we are' },
  { id: 'delegation', label: 'delegation', group: 'what continuing needs' },
  { id: 'next-task', label: 'next task', group: 'what continuing needs' },
  { id: 'local-decisions', label: 'local decisions', group: 'what continuing needs' },
  { id: 'owner-waits', label: 'owner waits', group: 'how to verify' },
  { id: 'decisions', label: 'decisions', group: 'what must not be lost' },
  { id: 'intake-tokens', label: 'intake tokens', group: 'what must not be lost' },
  { id: 'stop-reason', label: 'stop reason', group: 'what must not be lost' },
  { id: 'continue-when', label: 'continue when', group: 'what must not be lost' },
]
