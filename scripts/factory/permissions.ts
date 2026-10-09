export interface FactoryContract {
  allow: string[]
  denyMergeOfHead: string
}

export interface PullRequest {
  number: number
  headRefName: string
}

export interface Settings {
  permissions?: { allow?: string[], deny?: string[], [key: string]: unknown }
  [key: string]: unknown
}

export interface Rule {
  list: 'allow' | 'deny'
  rule: string
}

const PREFIX_RULE = /^Bash\((.+):\*\)$/

export function mergeDenyRule(number: number): string {
  return `Bash(gh pr merge ${number}:*)`
}

export function contractRules(contract: FactoryContract, pulls: PullRequest[]): Rule[] {
  const deny = pulls
    .filter(pull => pull.headRefName.startsWith(contract.denyMergeOfHead))
    .map(pull => ({ list: 'deny' as const, rule: mergeDenyRule(pull.number) }))
  return [...contract.allow.map(rule => ({ list: 'allow' as const, rule })), ...deny]
}

export function missingRules(rules: Rule[], settings: Settings): Rule[] {
  return rules.filter(({ list, rule }) => !(settings.permissions?.[list] ?? []).includes(rule))
}

export function withRules(settings: Settings, rules: Rule[]): Settings {
  const permissions = { ...settings.permissions }
  for (const { list, rule } of rules)
    permissions[list] = [...(permissions[list] ?? []), rule]
  return { ...settings, permissions }
}

export function rulePrefix(rule: string): string | null {
  return PREFIX_RULE.exec(rule)?.[1] ?? null
}

function prefixRules(allow: string[]): { rule: string, prefix: string }[] {
  return allow.flatMap((rule) => {
    const prefix = rulePrefix(rule)
    return prefix === null ? [] : [{ rule, prefix }]
  })
}

export function unmatchedCommands(commands: string[], allow: string[]): { command: string, rule: string }[] {
  const prefixes = prefixRules(allow)
  return commands.flatMap(command => prefixes
    .filter(({ prefix }) => namesPrefix(command, prefix) && !startsWithPrefix(command, prefix))
    .map(({ rule }) => ({ command, rule })))
}

export function unallowedCommands(commands: string[], allow: string[]): string[] {
  const prefixes = prefixRules(allow)
  return commands.filter(command => !allow.includes(`Bash(${words(command).join(' ')})`)
    && !prefixes.some(({ prefix }) => startsWithPrefix(command, prefix)))
}

const GH_GLOBAL_FLAGS_WITH_VALUE = new Set(['-R', '--repo'])

function withoutGhGlobalFlags(tokens: string[]): string[] {
  if (tokens[0] !== 'gh')
    return tokens
  let at = 1
  while (at < tokens.length && (GH_GLOBAL_FLAGS_WITH_VALUE.has(tokens[at]!) || tokens[at]!.startsWith('--repo=')))
    at += GH_GLOBAL_FLAGS_WITH_VALUE.has(tokens[at]!) ? 2 : 1
  return ['gh', ...tokens.slice(at)]
}

function words(text: string): string[] {
  return withoutGhGlobalFlags(text.trim().split(/\s+/))
}

function startsWithPrefix(command: string, prefix: string): boolean {
  const head = words(prefix)
  return words(command).slice(0, head.length).join(' ') === head.join(' ')
}

function namesPrefix(command: string, prefix: string): boolean {
  const head = words(prefix)
  const tokens = words(command)
  return tokens.some((_, at) => tokens.slice(at, at + head.length).join(' ') === head.join(' '))
}

export function backtickedCommands(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map(match => match[1]!)
}
