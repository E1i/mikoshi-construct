import type { Lease } from '../../core/lease.js'
import type { TreeCard, TreePrPorts } from '../../nodes/launch/tree-pr.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { gitTwins } from '../../nodes/answer/answer-executor.js'
import { refusalOf, treePr } from '../../nodes/launch/tree-pr.js'
import { declaredTestNames, unselectedWitnessesOf } from '../../ports/witnesses.js'

const WITNESS_FILE = 'scripts/tests/nodes/card.test.ts'
const CARD_TITLE = 'the card names this test'
const BRANCH = 'feat/card'
const CARD_ID = 7

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function rootOf(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function write(root: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), text)
}

function cardBody(test: string): string {
  return `# card\n\nwitnesses: ${JSON.stringify([{ id: 'W1', run: `pnpm exec vitest run ${WITNESS_FILE}`, test, head: 'pass', base: 'fail', proves: 'the card' }])}\n`
}

function testFile(...titles: string[]): string {
  return `import { describe, expect, it } from 'vitest'\n\ndescribe('the node', () => {\n${titles.map(title => `  it('${title}', () => {\n    expect(/\\(/.test('(')).toBe(true)\n  })\n`).join('')}})\n`
}

function launchCard(test: string): TreeCard {
  return { branch: BRANCH, title: 'card (#7)', commitMessage: 'card', cardLine: '#7 card', contour: 'cheap', touches: [WITNESS_FILE], runs: [], namedPathReason: null, cardId: CARD_ID, cardBody: cardBody(test) }
}

const pushed: string[] = []

const launchPorts: TreePrPorts = {
  git: (_cwd, args) => {
    pushed.push(args.join(' '))
    throw new Error('pushed')
  },
  gh: () => {
    throw new Error('no pull request')
  },
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function answerTree(): { tree: string, origin: string } {
  const root = rootOf('witness-title-answer-')
  const origin = path.join(root, 'origin.git')
  const tree = path.join(root, 'tree')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', tree])
  git(tree, ['config', 'user.email', 'bus@example.invalid'])
  git(tree, ['config', 'user.name', 'bus'])
  git(tree, ['remote', 'add', 'origin', origin])
  write(tree, 'README.md', 'card\n')
  git(tree, ['add', '-A'])
  git(tree, ['commit', '-q', '-m', 'base'])
  return { tree, origin }
}

function busWithBody(body: string): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE card_bodies (card_id INTEGER PRIMARY KEY, text TEXT NOT NULL)')
  db.prepare('INSERT INTO card_bodies (card_id, text) VALUES (?, ?)').run(CARD_ID, body)
  return db
}

function twinPush(tree: string, body: string): string | null {
  const db = busWithBody(body)
  try {
    return gitTwins(db, {} as CardTreeTools).commit({ session: 's', worktree: tree, branch: BRANCH }, { cardId: CARD_ID, pr: null } as Lease)
  }
  finally {
    db.close()
  }
}

function branchOnOrigin(origin: string): string {
  return git(origin, ['branch', '--list', BRANCH]).trim()
}

describe('a card witness selects a test in the head tree before the push', () => {
  it('a launch push whose witness -t matches no test in the head file is refused naming the declared test names', () => {
    const tree = rootOf('witness-title-launch-')
    write(tree, WITNESS_FILE, testFile('another title the session chose', 'a second title'))
    pushed.length = 0
    const outcome = treePr(launchPorts, launchCard(CARD_TITLE), tree, null)
    expect(pushed).toEqual([])
    expect(outcome.kind).toBe('problem')
    if (outcome.kind !== 'problem')
      return
    expect(refusalOf(outcome.gaps)).toMatchObject({ code: 'a:witness-unselected', class: 'a' })
    expect(outcome.why).toContain(`witness W1 -t '${CARD_TITLE}' selects no test in ${WITNESS_FILE}`)
    expect(outcome.why).toContain('"the node another title the session chose", "the node a second title"')
    expect(outcome.gaps[0]!.task).toContain(`-t '${CARD_TITLE}'`)
  })

  it('an answer push whose witness file is missing from the head tree is refused', () => {
    const { tree, origin } = answerTree()
    write(tree, 'scripts/tests/nodes/other.test.ts', testFile(CARD_TITLE))
    expect(twinPush(tree, cardBody(CARD_TITLE))).toBeNull()
    expect(branchOnOrigin(origin)).toBe('')
  })

  it('a push whose every witness selects a test goes through', () => {
    const { tree, origin } = answerTree()
    write(tree, WITNESS_FILE, testFile(`it ${CARD_TITLE} verbatim`))
    expect(twinPush(tree, cardBody(CARD_TITLE))).toBe(git(tree, ['rev-parse', 'HEAD']).trim())
    expect(branchOnOrigin(origin)).toBe(BRANCH)
    const launchTree = rootOf('witness-title-launch-')
    write(launchTree, WITNESS_FILE, testFile(CARD_TITLE))
    pushed.length = 0
    expect(treePr(launchPorts, launchCard('node the card'), launchTree, null)).toMatchObject({ kind: 'problem', gaps: [{ reason: 'commit-push-failed' }] })
    expect(pushed[0]).toBe('fetch -q origin main')
  })
})

describe('declared test names', () => {
  it('joins nested suite titles the way vitest -t reads the full name', () => {
    const source = `describe('outer', () => {\n  describe("inner", () => {\n    test(\`leaf\`, () => {})\n  })\n  it('it\\'s second', () => { items.forEach(x => x.test('(')) })\n})\nit('top', () => {})\n`
    expect(declaredTestNames(source)).toEqual(['outer inner leaf', 'outer it\'s second', 'top'])
  })

  it('judges nothing when a title is computed', () => {
    expect(declaredTestNames(`it.each([1])('case %s', () => {})\n`)).toBeNull()
    expect(declaredTestNames(`it(\`case ${'$'}{name}\`, () => {})\n`)).toBeNull()
    expect(unselectedWitnessesOf(cardBody(CARD_TITLE), () => 'it(name, () => {})\n')).toEqual([])
  })

  it('checks only a vitest run on one file with a test name', () => {
    const body = `witnesses: ${JSON.stringify([{ id: 'W1', run: 'pnpm exec vitest run a.test.ts b.test.ts', test: 'x', head: 'pass', base: 'fail', proves: 'p' }, { id: 'W2', run: `pnpm exec vitest run ${WITNESS_FILE}`, test: null, head: 'pass', base: 'fail', proves: 'p' }])}\n`
    expect(unselectedWitnessesOf(body, () => null)).toEqual([])
  })
})
