import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { changesetLevel, declaredFrom, readChangesets, semverLevel } from '../../scripts/contract/declared.js'

const CHANGESETS = path.resolve(import.meta.dirname, '../fixtures/contract/changesets')

describe('declaredLevel reads the bump a pull request declares', () => {
  it('reads each changeset\'s level for mikoshi-construct from its frontmatter', () => {
    expect(changesetLevel('---\n"mikoshi-construct": patch\n---\n\ntext\n')).toBe('patch')
    expect(changesetLevel('---\n\'mikoshi-construct\': major\n---\n')).toBe('major')
    expect(changesetLevel('---\n"another-package": major\n---\n')).toBe('none')
  })

  it('an ordinary pull request declares the strongest changeset, README.md excluded', () => {
    const changesets = readChangesets(CHANGESETS)
    expect(changesets).toHaveLength(3)
    expect(declaredFrom('0.18.0', '0.18.0', changesets)).toBe('minor')
  })

  it('no changeset declares none', () => {
    expect(declaredFrom('0.18.0', '0.18.0', [])).toBe('none')
  })

  it('0.17.2 → 0.18.0 with no changesets declares minor', () => {
    expect(declaredFrom('0.17.2', '0.18.0', [])).toBe('minor')
  })

  it('a version pull request declares its version difference, not its changesets', () => {
    expect(declaredFrom('0.18.0', '0.18.1', readChangesets(CHANGESETS))).toBe('patch')
  })

  it('names the semver level of a version difference', () => {
    expect(semverLevel('0.18.0', '1.0.0')).toBe('major')
    expect(semverLevel('0.18.0', '0.19.0')).toBe('minor')
    expect(semverLevel('0.18.0', '0.18.1')).toBe('patch')
    expect(semverLevel('0.18.0', '0.18.0')).toBe('none')
  })
})
