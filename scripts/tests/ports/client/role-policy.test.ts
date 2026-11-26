import { describe, expect, it } from 'vitest'
import { answerPolicy, launchPolicy } from '../../../ports/client/role-policy.js'

const GATE = ['pnpm run quality']

describe('the role session policy has one source', () => {
  it('a launch session is sandboxed with the tree gate, no extra write path and its card tools', () => {
    expect(launchPolicy(GATE, [])).toEqual({ profile: 'sandboxed', gateCommands: GATE, writePaths: [], mcpOff: true, tools: [] })
  })

  it('an answer session is sandboxed with the tree gate and only the write paths it is given', () => {
    expect(answerPolicy(GATE, ['/factory/answer/q.md'])).toEqual({ profile: 'sandboxed', gateCommands: GATE, writePaths: ['/factory/answer/q.md'], mcpOff: true, tools: undefined })
  })
})
