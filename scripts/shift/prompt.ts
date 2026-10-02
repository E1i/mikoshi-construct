import type { ShiftTask } from './task-file.js'

export interface PromptPlaces {
  worktree: string
  report: string
}

export function renderPrompt(header: string, task: ShiftTask, places: PromptPlaces): string {
  const values: Record<string, string> = {
    task: task.id,
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
  return `${rendered}${task.body}\n`
}
