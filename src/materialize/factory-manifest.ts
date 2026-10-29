import type { AiTarget } from '../presets/index.js'
import { aiGroups } from '../presets/index.js'

export const FACTORY_MANIFEST: readonly string[] = [
  '.claude/agents/brief.md',
  '.claude/agents/review.md',
  '.claude/agents/scan.md',
  '.claude/skills/probe/SKILL.md',
  '.claude/eddies.json',
  '.claude/settings.json',
  'architecture/owner-merges.md',
  'scripts/construct/check-acceptance.mjs',
  'scripts/construct/eddies.mjs',
  'scripts/construct/eddies-measure.mjs',
  'scripts/construct/window-heartbeat.mjs',
  'scripts/construct/window-hooks.mjs',
]

const FACTORY_RUNTIME_GROUP = 'ai/claude'

export function factoryTargetsFor(ai: AiTarget): string[] {
  return aiGroups(ai).includes(FACTORY_RUNTIME_GROUP) ? [...FACTORY_MANIFEST] : []
}
