import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { runsHarnessCommand } from './harness.js'

export interface WorkflowFacts {
  directory: string
  files: string[]
  harnessWorkflow: string | null
  unreadable: string[]
}

const WORKFLOWS_DIR = '.github/workflows'
const RUN_STEP = /(?:^|\s)run:[ \t]*(\S.*)$/

function runStepTexts(source: string): string[] {
  const lines = source.split('\n')
  const steps: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const inline = RUN_STEP.exec(lines[index])?.[1]
    if (inline == null)
      continue
    if (!inline.startsWith('|') && !inline.startsWith('>')) {
      steps.push(inline.trim())
      continue
    }
    const indent = lines[index].length - lines[index].trimStart().length
    const block: string[] = []
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]
      if (line.trim() !== '' && line.length - line.trimStart().length <= indent)
        break
      block.push(line.trim())
    }
    steps.push(block.join('\n'))
  }
  return steps
}

export function readWorkflowFacts(root: string, commandForms: string[]): WorkflowFacts {
  const directory = path.join(root, WORKFLOWS_DIR)
  if (!existsSync(directory))
    return { directory: WORKFLOWS_DIR, files: [], harnessWorkflow: null, unreadable: [] }
  const files = readdirSync(directory).filter(file => file.endsWith('.yml') || file.endsWith('.yaml')).sort()
  const unreadable: string[] = []
  let harnessWorkflow: string | null = null
  for (const file of files) {
    let source: string
    try {
      source = readFileSync(path.join(directory, file), 'utf8')
    }
    catch {
      unreadable.push(`${WORKFLOWS_DIR}/${file}`)
      continue
    }
    if (harnessWorkflow == null && runStepTexts(source).some(step => runsHarnessCommand(step, commandForms)))
      harnessWorkflow = `${WORKFLOWS_DIR}/${file}`
  }
  return { directory: WORKFLOWS_DIR, files, harnessWorkflow, unreadable }
}
