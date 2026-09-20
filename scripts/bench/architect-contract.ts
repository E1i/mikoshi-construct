import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const LADDER = 'scripts/construct/implement.workflow.mjs'
const AGENT = '.claude/agents/architect.md'

export interface JsonSchema {
  type: string
  required?: string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
}

export function specSchema(): JsonSchema {
  const source = readFileSync(path.join(REPO_ROOT, LADDER), 'utf8')
  const literal = /^const SPEC = (\{[\s\S]*?^\})$/m.exec(source)?.[1]
  if (literal == null)
    throw new Error(`SPEC is not declared in ${LADDER}`)
  // eslint-disable-next-line no-new-func
  return new Function(`return (${literal})`)() as JsonSchema
}

export function architectInstructions(): string {
  const source = readFileSync(path.join(REPO_ROOT, AGENT), 'utf8')
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  if (body.length === 0)
    throw new Error(`${AGENT} carries no instructions`)
  return body
}
