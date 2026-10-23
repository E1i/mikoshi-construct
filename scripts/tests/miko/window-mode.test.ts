import { describe, expect, it } from 'vitest'
import { CARD_VARIABLE, EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, WINDOW_MARK, WINDOW_VARIABLE, windowModeOf } from '../../ports/session.js'

describe('the window mode is decided by the session environment', () => {
  it('a session with the loop marks is in loop mode and one without marks or card is in tab mode', () => {
    const loopMarks = { [WINDOW_VARIABLE]: WINDOW_MARK, [LOOP_PID_VARIABLE]: '4242', [EXIT_REQUEST_VARIABLE]: '/h/miko-exit.4242.request' }
    expect(windowModeOf(loopMarks)).toBe('loop')
    expect(windowModeOf({ [WINDOW_VARIABLE]: WINDOW_MARK })).toBe('loop')
    expect(windowModeOf({ [LOOP_PID_VARIABLE]: '4242' })).toBe('loop')
    expect(windowModeOf({ [EXIT_REQUEST_VARIABLE]: '/h/miko-exit.4242.request' })).toBe('loop')
    expect(windowModeOf({ ...loopMarks, [CARD_VARIABLE]: '' })).toBe('loop')

    expect(windowModeOf({})).toBe('tab')
    expect(windowModeOf({ [WINDOW_VARIABLE]: '', [LOOP_PID_VARIABLE]: '', [EXIT_REQUEST_VARIABLE]: '', [CARD_VARIABLE]: '' })).toBe('tab')
    expect(windowModeOf({ [WINDOW_VARIABLE]: '0' })).toBe('tab')

    expect(windowModeOf({ [CARD_VARIABLE]: '1265' })).toBeNull()
    expect(windowModeOf({ ...loopMarks, [CARD_VARIABLE]: '1265' })).toBeNull()
  })
})
