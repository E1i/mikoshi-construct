import { describe, expect, it } from 'vitest'
import { parseTaskFile } from '../../shift/task-file.js'

describe('parseTaskFile', () => {
  it('reads the header up to the first blank line and keeps the rest as the prompt', () => {
    expect(parseTaskFile('07.md', 'task: 107\nbranch: feat/shift-runner\ntouches: scripts/shift/**, package.json\n\nDo it.\n\nCarefully.\n')).toEqual({
      kind: 'task',
      task: { file: '07.md', number: '07', id: '107', branch: 'feat/shift-runner', touches: ['scripts/shift/**', 'package.json'], body: 'Do it.\n\nCarefully.' },
    })
  })

  it.each([
    ['a missing key', 'task: 1\nbranch: b\n\nbody', '01.md: header is missing touches'],
    ['an unknown key', 'task: 1\nbranch: b\ntouches: a\nowner: me\n\nbody', `01.md: unknown header key 'owner'; the keys are task, branch, touches`],
    ['a repeated key', 'task: 1\ntask: 2\nbranch: b\ntouches: a\n\nbody', `01.md: header key 'task' appears twice`],
    ['a header line that is not key: value', 'task: 1\nbranch b\ntouches: a\n\nbody', `01.md: header line 'branch b' is not 'key: value'`],
    ['an empty body', 'task: 1\nbranch: b\ntouches: a\n\n\n', '01.md: the prompt body after the first blank line is empty'],
    ['a glob in the middle', 'task: 1\nbranch: b\ntouches: scripts/*/x.ts\n\nbody', `01.md: touches entry 'scripts/*/x.ts' may use '*' only as a trailing '/**'`],
    ['a bare /**', 'task: 1\nbranch: b\ntouches: /**\n\nbody', `01.md: touches entry '/**' names no path`],
    ['an absolute path', 'task: 1\nbranch: b\ntouches: /etc/x\n\nbody', `01.md: touches entry '/etc/x' must be a relative path inside the repository`],
    ['a path that climbs out', 'task: 1\nbranch: b\ntouches: ../x/**\n\nbody', `01.md: touches entry '../x/**' must be a relative path inside the repository`],
  ])('refuses %s', (_, text, reason) => {
    expect(parseTaskFile('01.md', text)).toEqual({ kind: 'refused', reason })
  })
})
