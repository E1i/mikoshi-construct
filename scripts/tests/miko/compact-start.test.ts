import { describe, expect, it } from 'vitest'
import { HANDOFF_DIR_VARIABLE } from '../../core/handoff-dir.js'
import { compactContextOf } from '../../miko/compact-start.js'
import { CONTINUE_PROMPT } from '../../miko/loop.js'
import { ENTRYPOINT_VARIABLE, HEADLESS_ENTRYPOINT } from '../../miko/tab.js'
import { CARD_VARIABLE, WINDOW_MARK, WINDOW_VARIABLE } from '../../ports/session.js'

const TAB = { CLAUDE_CODE_SESSION_ID: 's-tab', [HANDOFF_DIR_VARIABLE]: '/h' }
const always = (): boolean => true

describe('a compacted tab window is handed the continue prompt', () => {
  it('a tab window with a handoff gets CONTINUE_PROMPT after compaction', () => {
    expect(compactContextOf(TAB, file => file === '/h/miko.md')).toBe(CONTINUE_PROMPT)
  })

  it('a tab window without a handoff, a loop window, a card session and a headless session get nothing', () => {
    expect(compactContextOf(TAB, () => false)).toBeNull()
    expect(compactContextOf({ ...TAB, [WINDOW_VARIABLE]: WINDOW_MARK }, always)).toBeNull()
    expect(compactContextOf({ ...TAB, [CARD_VARIABLE]: '1266' }, always)).toBeNull()
    expect(compactContextOf({ ...TAB, [ENTRYPOINT_VARIABLE]: HEADLESS_ENTRYPOINT }, always)).toBeNull()
  })
})
