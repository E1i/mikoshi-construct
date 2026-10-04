import type { GitRunner } from '../../ghosts/range-diff.js'
import { describe, expect, it } from 'vitest'
import { pairMarkers, rangeDiffVerdict } from '../../ghosts/range-diff.js'

const APPROVED = 'a'.repeat(40)
const LAUNCHED = 'b'.repeat(40)
const MAIN = 'c'.repeat(40)

function fakeGit(overrides: Record<string, string | Error>): GitRunner {
  return (args) => {
    const answer = overrides[args[0]]
    if (answer instanceof Error)
      throw answer
    return answer ?? ''
  }
}

const PAIRS_EQUAL = '1:  abc1234 = 1:  def5678 sketch g2\n2:  abc1235 = 2:  def5679 more\n'

describe('pairMarkers', () => {
  it('reads one marker per commit pair and none from a patch body', () => {
    const output = `${PAIRS_EQUAL}-:  ------- > 3:  1111111 added\n3:  2222222 < -:  ------- dropped\n    @@ x\n    1:  aaa = 2:  bbb not a pair\n`
    expect(pairMarkers(output)).toEqual(['=', '=', '>', '<'])
  })

  it('reads a changed pair as !', () => {
    expect(pairMarkers('1:  abc1234 ! 1:  def5678 sketch g2\n    ## file ##\n')).toEqual(['!'])
  })
})

describe('rangeDiffVerdict', () => {
  it('passes when every commit of the launched range is paired with =', () => {
    expect(rangeDiffVerdict(fakeGit({ 'merge-base': 'd', 'rev-list': '2', 'range-diff': PAIRS_EQUAL }), APPROVED, LAUNCHED, MAIN)).toEqual({ ok: true })
  })

  it('refuses a changed commit, counting the commits it shows as =', () => {
    const verdict = rangeDiffVerdict(fakeGit({ 'merge-base': 'd', 'rev-list': '2', 'range-diff': '1:  abc1234 = 1:  def5678 a\n2:  abc1235 ! 2:  def5679 b\n' }), APPROVED, LAUNCHED, MAIN)
    expect(verdict).toEqual({ ok: false, reason: 'the sketch bbbbbbb is not the approved aaaaaaa rebased: git range-diff shows 1 of 2 commits as \'=\'; re-approve the brief' })
  })

  it('refuses a commit added or dropped even when every pair is =', () => {
    const added = rangeDiffVerdict(fakeGit({ 'merge-base': 'd', 'rev-list': '2', 'range-diff': '1:  abc1234 = 1:  def5678 a\n-:  ------- > 2:  def5679 b\n' }), APPROVED, LAUNCHED, MAIN)
    const dropped = rangeDiffVerdict(fakeGit({ 'merge-base': 'd', 'rev-list': '1', 'range-diff': '1:  abc1234 = 1:  def5678 a\n2:  abc1235 < -:  ------- b\n' }), APPROVED, LAUNCHED, MAIN)
    expect(added.ok).toBe(false)
    expect(dropped.ok).toBe(false)
  })

  it('refuses an empty range', () => {
    expect(rangeDiffVerdict(fakeGit({ 'merge-base': 'd', 'rev-list': '0', 'range-diff': '' }), APPROVED, LAUNCHED, MAIN).ok).toBe(false)
  })

  it('refuses, naming the approved sha, when it is not in the repository', () => {
    const verdict = rangeDiffVerdict(fakeGit({ 'cat-file': new Error('fatal: Not a valid object name') }), APPROVED, LAUNCHED, MAIN)
    expect(verdict).toEqual({ ok: false, reason: 'git range-diff cannot compare the approved sketch aaaaaaa with bbbbbbb (aaaaaaa is not in the repository); re-approve the brief' })
  })

  it('refuses with the first line of a git error', () => {
    const verdict = rangeDiffVerdict(fakeGit({ 'merge-base': new Error('\nfatal: no merge base\nmore') }), APPROVED, LAUNCHED, MAIN)
    expect(verdict.ok || verdict.reason).toContain('(fatal: no merge base)')
  })
})
