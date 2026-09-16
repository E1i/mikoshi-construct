import type { AiTarget } from '../presets/index.js'

export const CLAUDE_RULES_DIR = '.claude/rules/'
export const CURSOR_RULES_DIR = '.cursor/rules/'
export const DISCOVERY_PROTOCOL = '.claude/commands/construct-discover.md'
export const CURSOR_DISCOVERY_RULE = '.cursor/rules/construct-discover.mdc'

interface RuleSource {
  description: string
  paths: string[]
  body: string
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/

function unquote(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/, '$2')
}

function parseFrontmatter(block: string): { description?: string, paths: string[] } {
  const paths: string[] = []
  let description: string | undefined
  let inPaths = false
  for (const line of block.split('\n')) {
    const item = /^\s*-\s+(\S.*)$/.exec(line)
    if (inPaths && item != null) {
      paths.push(unquote(item[1]))
      continue
    }
    inPaths = /^paths:\s*$/.test(line)
    const scalar = /^description:\s*(\S.*)$/.exec(line)
    if (scalar != null)
      description = unquote(scalar[1])
  }
  return { description, paths }
}

function firstHeading(body: string): string | undefined {
  return /^#\s+(\S.*)$/m.exec(body)?.[1].trim()
}

export function parseClaudeRule(content: string): RuleSource {
  const match = FRONTMATTER.exec(content)
  const body = match == null ? content : content.slice(match[0].length).replace(/^\n+/, '')
  const front = match == null ? { paths: [] } : parseFrontmatter(match[1])
  return { description: front.description ?? firstHeading(body) ?? 'Project rule', paths: front.paths, body }
}

export function isClaudeRule(target: string): boolean {
  return target.startsWith(CLAUDE_RULES_DIR) && target.endsWith('.md')
}

export function cursorRuleTarget(target: string): string {
  return `${CURSOR_RULES_DIR}${target.slice(CLAUDE_RULES_DIR.length, -'.md'.length)}.mdc`
}

export function toCursorRule(content: string): string {
  const rule = parseClaudeRule(content)
  const always = rule.paths.length === 0
  const globs = always ? '' : `globs: ${rule.paths.join(', ')}\n`
  return `---\ndescription: ${rule.description}\n${globs}alwaysApply: ${always}\n---\n\n${rule.body}`
}

export function toCursorDiscoveryRule(content: string): string {
  const rule = parseClaudeRule(content)
  const body = rule.body.replaceAll('$ARGUMENTS', 'what the user asked to (re)discover')
  return `---\ndescription: ${rule.description}\nalwaysApply: false\n---\n\n${body}`
}

export function mapRulesForTargets(files: Map<string, string>, ai: AiTarget): Map<string, string> {
  const result = new Map<string, string>()
  for (const [target, content] of files) {
    const rule = isClaudeRule(target)
    const protocol = target === DISCOVERY_PROTOCOL
    if (!rule && !protocol) {
      result.set(target, content)
      continue
    }
    if (ai !== 'cursor')
      result.set(target, content)
    if (ai !== 'claude')
      result.set(protocol ? CURSOR_DISCOVERY_RULE : cursorRuleTarget(target), protocol ? toCursorDiscoveryRule(content) : toCursorRule(content))
  }
  return result
}
