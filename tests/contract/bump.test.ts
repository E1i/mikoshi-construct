import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { baseReading, baseTag, isWeaker, requiredLevel } from '../../scripts/contract/bump.js'
import { requiredChange, SECTIONS, UNBASELINED } from '../../scripts/contract/semantic-diff.js'
import { SURFACE_VERSION } from '../../scripts/contract/surface.js'
import { fixtureSurface, reading } from './surface-fixture.js'

describe('base selection', () => {
  it('a tag file of the same surfaceVersion is the base', () => {
    const recorded = fixtureSurface()
    const base = baseReading(recorded, 'v0.19.0')
    expect(base.reading).toEqual(recorded)
    expect(requiredChange(base.reading, fixtureSurface()).level).toBe('none')
  })

  it('a tag file of another surfaceVersion is not the base', () => {
    const base = baseReading({ ...fixtureSurface(), surfaceVersion: SURFACE_VERSION - 1 }, 'v0.18.0')
    expect(SECTIONS.map(section => base.reading[section])).toEqual(SECTIONS.map(() => UNBASELINED))
    expect(base.note).toContain('the whole base is unbaselined')
    expect(requiredChange(base.reading, fixtureSurface()).level).toBe('breaking')
  })

  it('a tag file with no surfaceVersion reads as version 1 and is not the base', () => {
    const { surfaceVersion: _, ...unversioned } = fixtureSurface()
    const base = baseReading(unversioned, 'v0.17.2')
    expect(base.note).toContain('surfaceVersion 1')
    expect(SECTIONS.map(section => base.reading[section])).toEqual(SECTIONS.map(() => UNBASELINED))
  })

  it('a tag with no file is not the base', () => {
    const base = baseReading(null, 'v0.1.0')
    expect(SECTIONS.map(section => base.reading[section])).toEqual(SECTIONS.map(() => UNBASELINED))
    expect(requiredChange(base.reading, fixtureSurface()).level).toBe('breaking')
  })

  it('the fixture reading is a whole surface', () => {
    expect(Object.keys(reading(fixtureSurface())).sort()).toEqual([...SECTIONS].sort())
  })
})

describe('the required level', () => {
  it('before 1.0: none → none, additive → patch, breaking → minor', () => {
    expect(requiredLevel('none', '0.18.0')).toBe('none')
    expect(requiredLevel('additive', '0.18.0')).toBe('patch')
    expect(requiredLevel('breaking', '0.18.0')).toBe('minor')
  })

  it('from 1.0: none → none, additive → minor, breaking → major', () => {
    expect(requiredLevel('none', '1.2.0')).toBe('none')
    expect(requiredLevel('additive', '1.2.0')).toBe('minor')
    expect(requiredLevel('breaking', '1.2.0')).toBe('major')
  })

  it('fails only a declared level weaker than the required one', () => {
    expect(isWeaker('patch', 'minor')).toBe(true)
    expect(isWeaker('none', 'patch')).toBe(true)
    expect(isWeaker('minor', 'minor')).toBe(false)
    expect(isWeaker('major', 'minor')).toBe(false)
    expect(isWeaker('none', 'none')).toBe(false)
  })
})

describe('base tag selection', () => {
  let repo: string
  let clock = Date.UTC(2026, 0, 1) / 1000

  function git(...args: string[]): string {
    clock += 3600
    const date = `${clock} +0000`
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    })
  }

  function commitAndTag(file: string, tag: string): void {
    writeFileSync(path.join(repo, file), tag)
    git('add', file)
    git('commit', '-q', '-m', tag)
    git('tag', '-a', tag, '-m', tag)
  }

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'construct-base-tag-'))
    git('init', '-q', '-b', 'main')
    commitAndTag('a.txt', 'v0.1.0')
    commitAndTag('b.txt', 'v0.2.0')
    git('checkout', '-q', '-b', 'side', 'v0.1.0')
    commitAndTag('c.txt', 'v0.3.0')
  })

  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  it('on main, HEAD resolves to the latest tag it contains', () => {
    git('checkout', '-q', 'main')
    expect(baseTag(repo)).toBe('v0.2.0')
  })

  it('on the side branch, HEAD resolves to its own tag', () => {
    git('checkout', '-q', 'side')
    expect(baseTag(repo)).toBe('v0.3.0')
  })
})
