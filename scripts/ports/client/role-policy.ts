import type { SessionPolicy, SessionTool } from './contract.js'

export function launchPolicy(gateCommands: string[], tools?: readonly SessionTool[]): SessionPolicy {
  return { profile: 'sandboxed', gateCommands, writePaths: [], mcpOff: true, tools }
}

export function answerPolicy(gateCommands: string[], writePaths: string[], tools?: readonly SessionTool[]): SessionPolicy {
  return { profile: 'sandboxed', gateCommands, writePaths, mcpOff: true, tools }
}
