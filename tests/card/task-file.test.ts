import { describe, expect, it } from 'vitest'
import { parseCard } from '../../src/card/grammar.js'
import { parseTaskFile } from '../../src/card/task-file.js'

const CARD = '#107 shift-runner [implement/runner/M/cheap/owner] · depends — · blocks —'

describe('parseTaskFile', () => {
  it('reads the header up to the first blank line and keeps the rest as the prompt', () => {
    expect(parseTaskFile('07.md', `card: ${CARD}\nbranch: feat/shift-runner\ntouches: scripts/shift/**, package.json\n\nDo it.\n\nCarefully.\n`)).toEqual({
      kind: 'task',
      task: { file: '07.md', number: '07', id: '107', card: (parseCard(CARD) as { card: unknown }).card, branch: 'feat/shift-runner', touches: ['scripts/shift/**', 'package.json'], body: 'Do it.\n\nCarefully.', continue: 'stop' },
    })
  })

  it.each(['auto', 'stop'] as const)('reads continue: %s', (mode) => {
    const parsed = parseTaskFile('01.md', `card: ${CARD}\nbranch: b\ntouches: a\ncontinue: ${mode}\n\nbody`)
    expect(parsed).toMatchObject({ kind: 'task', task: { continue: mode } })
  })

  it.each([
    ['a missing key', 'card: C\nbranch: b\n\nbody', '01.md: header is missing touches'],
    ['an unknown key', 'card: C\nbranch: b\ntouches: a\nowner: me\n\nbody', `01.md: unknown header key 'owner'; the keys are card, branch, touches, continue`],
    ['a repeated key', 'card: C\ncard: C\nbranch: b\ntouches: a\n\nbody', `01.md: header key 'card' appears twice`],
    ['a header line that is not key: value', 'card: C\nbranch b\ntouches: a\n\nbody', `01.md: header line 'branch b' is not 'key: value'`],
    ['an empty body', 'card: C\nbranch: b\ntouches: a\n\n\n', '01.md: the prompt body after the first blank line is empty'],
    ['a glob in the middle', 'card: C\nbranch: b\ntouches: scripts/*/x.ts\n\nbody', `01.md: touches entry 'scripts/*/x.ts' may use '*' only as a trailing '/**'`],
    ['a bare /**', 'card: C\nbranch: b\ntouches: /**\n\nbody', `01.md: touches entry '/**' names no path`],
    ['an absolute path', 'card: C\nbranch: b\ntouches: /etc/x\n\nbody', `01.md: touches entry '/etc/x' must be a relative path inside the repository`],
    ['a path that climbs out', 'card: C\nbranch: b\ntouches: ../x/**\n\nbody', `01.md: touches entry '../x/**' must be a relative path inside the repository`],
    ['a task: key', 'task: 1\nbranch: b\ntouches: a\n\nbody', `01.md: 'task:' is replaced by 'card: <the task's card>'; the id is the card's #<id>`],
    ['a continue value that is neither auto nor stop', 'card: C\nbranch: b\ntouches: a\ncontinue: yes\n\nbody', `01.md: continue 'yes' is not one of auto, stop`],
    ['a card of the wrong form', 'card: #1 x [probe/ice/S/cheap/owner] · depends — · blocks —\nbranch: b\ntouches: a\n\nbody', '01.md: card refused: kind probe takes decision none, not owner'],
  ])('refuses %s', (_, text, reason) => {
    expect(parseTaskFile('01.md', text.replaceAll('card: C\n', `card: ${CARD}\n`))).toEqual({ kind: 'refused', reason })
  })
})
