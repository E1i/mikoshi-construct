import { describe, expect, it } from 'vitest'
import { notificationScript, osascriptNotify } from '../../shift/notify.js'

describe('the shift notifier', () => {
  it('quotes the title and the message as AppleScript strings', () => {
    expect(notificationScript('shift: #1 failed', 'said "no" at C:\\x\nthen')).toBe('display notification "said \\"no\\" at C:\\\\x then" with title "shift: #1 failed"')
  })

  it('runs osascript -e with the script on macOS', () => {
    const calls: [string, string[]][] = []
    osascriptNotify('darwin', (command, args) => calls.push([command, args]))('t', 'm')
    expect(calls).toEqual([['osascript', ['-e', 'display notification "m" with title "t"']]])
  })

  it('does nothing off macOS and never throws when osascript cannot run', () => {
    const calls: string[] = []
    osascriptNotify('linux', command => calls.push(command))('t', 'm')
    expect(calls).toEqual([])
    expect(() => osascriptNotify('darwin', () => {
      throw new Error('ENOENT')
    })('t', 'm')).not.toThrow()
  })
})
