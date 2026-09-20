import type { PresetId } from '../../presets/index.js'
import type { HarnessFacts } from './harness.js'

interface TypecheckCaveat {
  checkers: string[]
  text: string
}

const CAVEATS: Partial<Record<PresetId, TypecheckCaveat>> = {
  'node-frontend': {
    checkers: ['vue-tsc', 'svelte-check'],
    text: 'node-frontend: `tsc --noEmit` does not see `.vue` or `.svelte` single-file components, so a Vite app that adds them needs the framework\'s own checker (vue-tsc, svelte-check) in the harness',
  },
}

export function typecheckWarnings(preset: PresetId, harness: HarnessFacts): string[] {
  const caveat = CAVEATS[preset]
  if (caveat == null || caveat.checkers.some(checker => harness.resolved.includes(checker)))
    return []
  return [caveat.text]
}
