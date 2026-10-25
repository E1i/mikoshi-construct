import { describe, expect, it } from 'vitest'
import { HANDOFF_DIR_VARIABLE } from '../../core/handoff-dir.js'
import { compactContextOf, sourceOf } from '../../window/compact-start.js'
import { CONTINUE_PROMPT } from '../../window/loop.js'
import { ENTRYPOINT_VARIABLE, HEADLESS_ENTRYPOINT } from '../../window/tab.js'
import { CARD_VARIABLE, WINDOW_MARK, WINDOW_VARIABLE } from '../../ports/session.js'

const TAB = { CLAUDE_CODE_SESSION_ID: 's-tab', [HANDOFF_DIR_VARIABLE]: '/h' }
const always = (): boolean => true

describe('a compacted tab window is handed the continue prompt', () => {
  it('a tab window with a handoff gets CONTINUE_PROMPT after compaction', () => {
    expect(compactContextOf('compact', TAB, file => file === '/h/miko.md')).toBe(CONTINUE_PROMPT)
  })

  it('a tab window without a handoff, a loop window, a card session and a headless session get nothing', () => {
    expect(compactContextOf('compact', TAB, () => false)).toBeNull()
    expect(compactContextOf('compact', { ...TAB, [WINDOW_VARIABLE]: WINDOW_MARK }, always)).toBeNull()
    expect(compactContextOf('compact', { ...TAB, [CARD_VARIABLE]: '1266' }, always)).toBeNull()
    expect(compactContextOf('compact', { ...TAB, [ENTRYPOINT_VARIABLE]: HEADLESS_ENTRYPOINT }, always)).toBeNull()
  })

  it('a session started, resumed or cleared gets nothing, and so does unreadable input', () => {
    for (const source of ['startup', 'resume', 'clear', null])
      expect(compactContextOf(source, TAB, always)).toBeNull()
    expect([sourceOf('{"source":"compact"}'), sourceOf('{}'), sourceOf('not json'), sourceOf('null')]).toEqual(['compact', null, null, null])
  })
})
