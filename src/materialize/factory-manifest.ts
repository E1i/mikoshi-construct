import type { AiTarget } from '../presets/index.js'
import { FACTORY_MANIFEST } from '../../scripts/policy/touch-scope.js'
import { aiGroups } from '../presets/index.js'

const FACTORY_RUNTIME_GROUP = 'ai/claude'

export function factoryTargetsFor(ai: AiTarget): string[] {
  return aiGroups(ai).includes(FACTORY_RUNTIME_GROUP) ? [...FACTORY_MANIFEST] : []
}
