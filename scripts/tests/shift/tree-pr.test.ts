import type { TreeCard, TreePrPorts } from '../../shift/tree-pr.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { reduce } from '../../bus/reducer.js'
import { CARD_ADMITTED } from '../../core/events.js'
import { busCardText, PREFIX, runTreePr } from '../../shift/tree-pr-cli.js'
import { treePr } from '../../shift/tree-pr.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const CARD: TreeCard = {
  branch: 'feat/x',
  title: 'x (#1)',
  commitMessage: 'x (#1)',
  cardLine: '#1 x [implement/infra/S/cheap/auto] · depends — · blocks —',
  contour: 'cheap',
  touches: ['scripts/x.ts'],
  runs: [],
  namedPathReason: null,
}

function repoWithoutOrigin(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-'))
  roots.push(root)
  execFileSync('git', ['-C', root, 'init', '-q'])
  return root
}

describe('treePr', () => {
  it('a failed push reports git stderr in the problem', () => {
    const worktree = repoWithoutOrigin()
    const ports: TreePrPorts = {
      git: (cwd, args) => {
        if (args[0] === 'status')
          return ''
        if (args[0] === 'rev-list')
          return '1\n'
        return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      },
      gh: () => {
        throw new Error('no gh call is expected')
      },
    }
    const result = treePr(ports, CARD, worktree, null)
    expect(result.kind).toBe('problem')
    expect(result.kind === 'problem' && result.why).toMatch(/^the shift could not commit, push or open the pull request of feat\/x: Command failed: git -C .+ push -q -u origin HEAD:refs\/heads\/feat\/x: error: src refspec HEAD does not match any · error: failed to push some refs to 'origin'$/)
  })
})

describe('the base of the tree', () => {
  it('tree-pr refuses a tree whose merge-base is not the PR base', () => {
    const calls: string[][] = []
    const ports: TreePrPorts = {
      git: (_cwd, args) => {
        calls.push(args)
        if (args[0] === 'rev-list')
          return '1\n'
        if (args[0] === 'rev-parse')
          return `${'b'.repeat(40)}\n`
        if (args[0] === 'merge-base')
          return `${'a'.repeat(40)}\n`
        return ''
      },
      gh: (args) => {
        if (args[1] === 'list')
          return '[]'
        throw new Error('no pull request is opened off its base')
      },
    }
    expect(treePr(ports, CARD, '/tree', null)).toEqual({ kind: 'problem', why: `the shift opened no pull request for feat/x: its merge-base ${'a'.repeat(40)} is not the PR base origin/main at ${'b'.repeat(40)}; bring the tree onto origin/main first` })
    expect(calls).toContainEqual(['merge-base', 'HEAD', 'origin/main'])
  })
})

describe('tree-pr reads its card from the bus', () => {
  const CARD_TEXT = parkingFileText({ card: '#951 x [implement/netwatch/S/cheap/auto] · depends — · blocks —', branch: 'feat/x', touches: ['docs/x.md'], continue: 'stop', who: 'shift', body: 'Do x.' })

  function busWithCard(root: string): string {
    const busPath = path.join(root, 'bus.db')
    const db = openBus(busPath)
    try {
      appendEvent(db, { ts: '2026-10-21T00:00:00.000Z', type: CARD_ADMITTED, actor: 'policy', cardId: 951, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:951`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: 'admission-951', text: CARD_TEXT, textSha: textSha(CARD_TEXT) }, legacy: false })
      reduce(db)
    }
    finally {
      db.close()
    }
    return busPath
  }

  function docsOnlyPorts(bodies: string[]): TreePrPorts {
    return {
      git: (_cwd, args) => {
        if (args[0] === 'rev-list')
          return '1\n'
        if (args[0] === 'show' && args[1] === 'HEAD:package.json')
          return JSON.stringify({ files: ['dist', 'templates'] })
        if (args.includes('--name-status'))
          return 'M\0docs/x.md\0'
        if (args.includes('--numstat'))
          return '1\t0\tdocs/x.md\0'
        return ''
      },
      gh: (args) => {
        if (args[1] === 'list')
          return '[]'
        bodies.push(args[args.indexOf('--body') + 1]!)
        return 'https://github.com/o/r/pull/901\n'
      },
    }
  }

  it('tree-pr opens the pull request when the card file moved during the session', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-'))
    roots.push(root)
    const busPath = busWithCard(root)
    const parked = path.join(root, 'parking', 'lane-a', '951.md')
    mkdirSync(path.dirname(parked), { recursive: true })
    writeFileSync(parked, CARD_TEXT)
    mkdirSync(path.join(root, 'parking', 'lane-b'))
    renameSync(parked, path.join(root, 'parking', 'lane-b', '951.md'))
    const bodies: string[] = []
    const opened: [number, number][] = []
    const lines: string[] = []

    const code = runTreePr(['951', root], { ...docsOnlyPorts(bodies), card: busCardText(busPath), opened: (cardId, pr) => opened.push([cardId, pr]), stopped: () => {} }, line => lines.push(line))

    expect({ code, lines, opened, cardLine: bodies.map(body => body.split('\n')[0]) }).toEqual({ code: 0, lines: [`${PREFIX}card #951: PR #901`], opened: [[951, 901]], cardLine: ['#951 x [implement/netwatch/S/cheap/auto] · depends — · blocks —'] })
  })

  it('the bus port reads no body of a card the bus never admitted, and creates no bus file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-'))
    roots.push(root)
    const busPath = busWithCard(root)
    const absent = path.join(root, 'no-bus.db')

    expect({ admitted: busCardText(busPath)(951), other: busCardText(busPath)(952), absent: busCardText(absent)(951), created: existsSync(absent) }).toEqual({ admitted: CARD_TEXT, other: null, absent: null, created: false })
  })
})
