export type Role = 'launch' | 'answer' | 'review' | 'ladder' | 'ghost' | 'window'

export type SessionTool = 'web' | 'skills' | 'agents'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ModelChoice = 'auto' | string

export interface ModelPick {
  model: string | null
  effort: Effort | null
}

export interface Refusal {
  kind: 'refused'
  reason: string
}

export interface ClientAdapter {
  readonly id: string
  readonly capabilities: Capabilities
  invocation: (spec: SessionSpec) => Invocation | Refusal
  reading: (place: SessionPlace) => SessionReading
  readBudget: (place: SessionPlace) => ReadBudget
  models: () => ModelOffer[] | null
  modelFor: (role: Role, effort: Effort | null, wanted: ModelChoice) => ModelPick | Refusal
  processes: ClientProcesses
  ownSession: (env: NodeJS.ProcessEnv) => string | null
}

export interface SessionPolicy {
  profile: 'sandboxed' | 'client-default'
  gateCommands: string[]
  writePaths: string[]
  mcpOff: boolean
  tools?: readonly SessionTool[]
}

export interface SessionSpec {
  kind: 'start' | 'resume'
  role: Role
  session: string
  cwd: string
  prompt: string
  addDirs: string[]
  pick: Pick<ModelPick, 'model'> & Partial<Pick<ModelPick, 'effort'>>
  policy: SessionPolicy
}

export interface Invocation {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  stdin: string | null
}

export interface SessionPlace {
  session: string
  cwd: string
  stdoutPath: string | null
}

export interface Usage {
  input: number
  cached: number
  cacheWrite: number
  output: number
  reasoning: number
}

export interface Denial {
  tool: string
  path: string | null
  command: string | null
  text: string
}

export interface ToolUse {
  kind: 'write' | 'exec' | 'other'
  command: string | null
  path: string | null
}

export type JournalChange = { kind: 'write', content: string, at: number } | { kind: 'edit', oldString: string, newString: string, replaceAll: boolean, at: number }

export interface SessionJournal {
  end: number
  changes: ReadonlyMap<string, JournalChange[]>
}

export interface SessionReading {
  end: 'completed' | 'failed' | 'missing'
  failure: string | null
  usage: Usage | null
  costUsd: number | null
  turns: number | null
  durationMs: number | null
  model: string | null
  denials: Denial[]
  toolUses: ToolUse[]
  journal: SessionJournal | 'unreadable'
  lastSteps: string[] | null
  contextTokens: number | null
}

export interface ReadBudget {
  startContext: number | null
  readBeforeEdit: number | null
}

export interface ModelOffer {
  id: string
  efforts: Effort[]
  contextWindow: number | null
  recommendedFor: Role[]
}

export interface Capabilities {
  identity: 'assigned' | 'reported'
  ladder: boolean
  reports: {
    cost: boolean
    turns: boolean
    model: boolean
    denials: boolean
    journal: boolean
  }
  guarantees: {
    allowlist: boolean
    writeConfinement: boolean
    mcpOff: boolean
    toolNarrowing: boolean
    guardFailsClosed: boolean
  }
}

export type ProcessCwds = { kind: 'listed', cwds: string[] } | { kind: 'unreadable', why: string }

export interface ClientProcesses {
  isClient: (argv: string) => boolean
  sessionMarker: (session: string) => string | null
  processNames: readonly string[]
  isolationCommand: () => string[]
}
