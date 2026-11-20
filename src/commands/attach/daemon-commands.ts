import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { listTemplateFiles } from '../../materialize/templates.js'

export const DAEMON_KEY = 'daemon'
export const DAEMON_COMMAND_KEY = 'daemon-command'
export const HOME_PLACEHOLDER = '<home>'
export const SETTINGS_FILE = '.claude/settings.local.json'
export const PROJECT_SETTINGS_FILE = '.claude/settings.json'
export const DAEMON_SKILLS_GROUP = 'ai/claude'
const SKILL_MANIFEST_TARGET = /^\.claude\/skills\/[^/]+\/SKILL\.md$/
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/
const FIELD = /^([\w-]+):(.*)$/

export function frontmatterFields(text: string): Array<readonly [string, string]> {
  const block = FRONTMATTER.exec(text)?.[1] ?? ''
  return block.split(/\r?\n/).flatMap((line) => {
    const field = FIELD.exec(line)
    return field === null ? [] : [[field[1]!, field[2]!.trim()] as const]
  })
}

export function declaredCommands(text: string, home: string = homedir()): string[] {
  const fields = frontmatterFields(text)
  const daemon = fields.find(([key]) => key === DAEMON_KEY)?.[1]
  if (daemon === undefined || daemon === '')
    return []
  const commands = fields.filter(([key, value]) => key === DAEMON_COMMAND_KEY && value !== '').map(([, value]) => value.replaceAll(HOME_PLACEHOLDER, home))
  return [...new Set(commands)]
}

export function allowRule(command: string): string {
  return `Bash(${command})`
}

export function daemonProgram(command: string): string | null {
  return command.split(/\s+/).find(word => path.isAbsolute(word)) ?? null
}

export function shippedDaemonCommands(home: string = homedir()): string[] {
  const manifests = listTemplateFiles(DAEMON_SKILLS_GROUP).filter(file => SKILL_MANIFEST_TARGET.test(file.target))
  return [...new Set(manifests.flatMap(file => declaredCommands(readFileSync(file.source, 'utf8'), home)))]
}
