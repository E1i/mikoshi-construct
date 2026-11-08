import { describe, expect, it } from 'vitest'
import { CARD_VARIABLE, EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, WINDOW_MARK, WINDOW_VARIABLE, windowModeOf } from '../../ports/session.js'
import { TAB_MODE } from '../../window/loop.js'

describe('the window mode is decided by the session environment', () => {
  it('a session with the loop marks is in loop mode, one with the tab launcher\'s mark in tab mode, and one without marks is no window', () => {
    const loopMarks = { [WINDOW_VARIABLE]: WINDOW_MARK, [LOOP_PID_VARIABLE]: '4242', [EXIT_REQUEST_VARIABLE]: '/h/miko-exit.4242.request' }
    expect(windowModeOf(loopMarks)).toBe('loop')
    expect(windowModeOf({ [WINDOW_VARIABLE]: WINDOW_MARK })).toBe('loop')
    expect(windowModeOf({ [LOOP_PID_VARIABLE]: '4242' })).toBe('loop')
    expect(windowModeOf({ [EXIT_REQUEST_VARIABLE]: '/h/miko-exit.4242.request' })).toBe('loop')
    expect(windowModeOf({ ...loopMarks, [CARD_VARIABLE]: '' })).toBe('loop')

    expect(windowModeOf({ [WINDOW_VARIABLE]: TAB_MODE })).toBe('tab')
    expect(windowModeOf({ [WINDOW_VARIABLE]: TAB_MODE, [LOOP_PID_VARIABLE]: '', [EXIT_REQUEST_VARIABLE]: '', [CARD_VARIABLE]: '' })).toBe('tab')

    expect(windowModeOf({})).toBeNull()
    expect(windowModeOf({ [WINDOW_VARIABLE]: '', [LOOP_PID_VARIABLE]: '', [EXIT_REQUEST_VARIABLE]: '', [CARD_VARIABLE]: '' })).toBeNull()
    expect(windowModeOf({ [WINDOW_VARIABLE]: '0' })).toBeNull()

    expect(windowModeOf({ [CARD_VARIABLE]: '1265' })).toBeNull()
    expect(windowModeOf({ ...loopMarks, [CARD_VARIABLE]: '1265' })).toBeNull()
  })
})
