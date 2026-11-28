import { defaultWindowOf } from '../../window/loop.js'
import { claudeClient } from './claude-client.js'

export const claudeWindow = defaultWindowOf(claudeClient)
export const CLAUDE_VARIABLE = claudeWindow.variable
export const DEFAULT_CLAUDE = claudeWindow.command({})
export const claudeCommand = claudeWindow.command
