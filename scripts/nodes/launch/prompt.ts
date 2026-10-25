import type { ShiftTask } from '../../../src/card/task-file.js'
import type { ShiftGate } from '../../../src/manifest.js'
import { HANDOFF_FIELDS } from '../../core/handoff-fields.js'
import { CONTINUE_PROMPT } from './continuation.js'

const PROBE_SKILL = '.claude/skills/probe/SKILL.md'
const PROBE_SKILL_LINE = `Прочитай ${PROBE_SKILL} целиком и работай по нему`
const DECLARED_SECTION = /\{\{\?(\w+)\}\}\n([\s\S]*?)\{\{\/\1\}\}\n/g

export interface PromptPlaces {
  worktree: string
  report: string
  gate: ShiftGate
}

function backticked(entries: readonly string[]): string {
  return entries.map(entry => `\`${entry}\``).join(', ')
}

function declaredSections(gate: ShiftGate): Record<string, boolean> {
  return { matrix: gate.codeMatrix !== null, handoff: gate.handoffWrite !== null }
}

export function renderPrompt(header: string, task: ShiftTask, places: PromptPlaces): string {
  const { gate } = places
  const values: Record<string, string> = {
    task: task.id,
    card: task.card.line,
    branch: task.branch,
    touches: backticked(task.touches),
    worktree: places.worktree,
    report: places.report,
    prepush: backticked(gate.prepush),
    handoffFields: backticked(HANDOFF_FIELDS.map(field => field.label)),
    codeMatrix: gate.codeMatrix ?? '',
    handoffWrite: gate.handoffWrite ?? '',
  }
  const sections = declaredSections(gate)
  const kept = header.replaceAll(DECLARED_SECTION, (_, name: string, text: string) => {
    const declared = sections[name]
    if (declared === undefined)
      throw new Error(`header names an unknown section {{?${name}}}`)
    return declared ? text : ''
  })
  const rendered = kept.replaceAll(/\{\{(\w+)\}\}/g, (_, name: string) => {
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
