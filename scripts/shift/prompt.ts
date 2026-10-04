import type { ShiftTask } from '../../src/card/task-file.js'
import { CONTINUE_PROMPT } from './continuation.js'

const PROBE_SKILL = '.claude/skills/probe/SKILL.md'
const PROBE_SKILL_LINE = `Прочитай ${PROBE_SKILL} целиком и работай по нему`

export interface PromptPlaces {
  worktree: string
  report: string
}

export function renderPrompt(header: string, task: ShiftTask, places: PromptPlaces): string {
  const values: Record<string, string> = {
    task: task.id,
    card: task.card.line,
    branch: task.branch,
    touches: task.touches.map(entry => `\`${entry}\``).join(', '),
    worktree: places.worktree,
    report: places.report,
  }
  const rendered = header.replaceAll(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = values[name]
    if (value === undefined)
      throw new Error(`header names an unknown variable {{${name}}}`)
    return value
  })
  return `${rendered}${bodyOf(task)}\n`
}

export function continuationBody(task: ShiftTask, places: PromptPlaces): string {
  return `${CONTINUE_PROMPT}: the shift report \`${places.report}\`, the handoff and the commits on \`${task.branch}\` say where the last session stopped.`
}

function bodyOf(task: ShiftTask): string {
  if (task.card.kind !== 'probe' || task.body.includes(PROBE_SKILL))
    return task.body
  return `${PROBE_SKILL_LINE}\n\n${task.body}`
}
