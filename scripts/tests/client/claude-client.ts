import { claudeAdapterWith } from '../../ports/client/claude/adapter.js'
import { settingsFlag, shiftSettings } from '../../ports/shift-settings.js'

export const claudeClient = claudeAdapterWith({ shiftSettings, settingsFlag })
