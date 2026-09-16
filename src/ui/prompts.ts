import type { CommonOptions } from '@clack/prompts'
import type { AiTarget, Preset, PresetId } from '../presets/index.js'
import type { Lore } from './lore.js'
import { cancel, confirm, isCancel, multiselect, select, text } from '@clack/prompts'
import { AI_TARGET_LABELS } from '../presets/index.js'

export interface Prompter {
  preset: (choices: Preset[], initial?: PresetId) => Promise<PresetId | undefined>
  aiTarget: (initial: AiTarget) => Promise<AiTarget | undefined>
  projectName: (initial: string) => Promise<string | undefined>
  review: (initial: boolean) => Promise<boolean | undefined>
  confirm: (message: string) => Promise<boolean | undefined>
}

type SingleAiTarget = Exclude<AiTarget, 'both'>

const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

export function isValidProjectName(value: string): boolean {
  return PROJECT_NAME_PATTERN.test(value)
}

export function toAiTarget(selected: SingleAiTarget[]): AiTarget {
  if (selected.includes('claude') && selected.includes('cursor'))
    return 'both'
  return selected.includes('cursor') ? 'cursor' : 'claude'
}

export function fromAiTarget(target: AiTarget): SingleAiTarget[] {
  return target === 'both' ? ['claude', 'cursor'] : [target]
}

export type PromptStreams = Pick<CommonOptions, 'input' | 'output'>

export function createClackPrompter(lore: Lore, streams: PromptStreams = {}): Prompter {
  const settle = <T>(value: T): Exclude<T, symbol> | undefined => {
    if (isCancel(value)) {
      cancel(lore.cancelled, streams)
      return undefined
    }
    return value as Exclude<T, symbol>
  }

  return {
    async preset(choices, initial) {
      const answer = await select<PresetId>({
        ...streams,
        message: lore.askPreset,
        options: choices.map(choice => ({
          value: choice.id,
          label: choice.label,
          hint: choice.available ? choice.description : lore.presetUnavailable,
          disabled: !choice.available,
        })),
        initialValue: initial,
      })
      return settle(answer)
    },
    async aiTarget(initial) {
      const answer = await multiselect<SingleAiTarget>({
        ...streams,
        message: lore.askAi,
        options: [
          { value: 'claude', label: AI_TARGET_LABELS.claude },
          { value: 'cursor', label: AI_TARGET_LABELS.cursor },
        ],
        initialValues: fromAiTarget(initial),
        required: true,
      })
      const selected = settle(answer)
      return selected == null ? undefined : toAiTarget(selected)
    },
    async projectName(initial) {
      const answer = await text({
        ...streams,
        message: lore.askName,
        initialValue: initial,
        validate: value => (isValidProjectName(value ?? '') ? undefined : lore.nameInvalid),
      })
      const value = settle(answer)
      return value?.trim()
    },
    async review(initial) {
      return settle(await confirm({ ...streams, message: lore.askReview, initialValue: initial }))
    },
    async confirm(message) {
      return settle(await confirm({ ...streams, message, initialValue: true }))
    },
  }
}
