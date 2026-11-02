import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bumpOf, gitIn, pendingChangesets, raisedVersion, readReleaseRoute, readReleaseVersion, releaseVersionFrom, routeFrom } from '../../release/changesets.js'

function changesetDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-changeset-'))
  for (const [name, body] of Object.entries(files))
    writeFileSync(path.join(dir, name), body)
  return dir
}

describe('what the release action does with a tree is read from the tree', () => {
  it('counts a changeset and passes over the two files the directory always carries', () => {
    expect(pendingChangesets(['README.md', 'config.json', 'ninety-nine-moles-sit.md'])).toEqual(['ninety-nine-moles-sit.md'])
  })

  it('passes over a README written in any casing, since only the changesets decide the route', () => {
    expect(pendingChangesets(['readme.md', 'Readme.md'])).toEqual([])
  })

  it('reads a tree carrying an unconsumed changeset as one the action versions rather than publishes', () => {
    expect(routeFrom(['README.md', 'config.json', 'olive-pugs-repeat.md'])).toBe('versioning')
  })

  it('reads a tree with every changeset consumed as one the action publishes', () => {
    expect(routeFrom(['README.md', 'config.json'])).toBe('publishing')
  })

  it('reads a real directory holding a changeset as versioning, and names the file it read', () => {
    const dir = changesetDir({ 'README.md': '', 'config.json': '{}', 'plain-eels-shake.md': '---\n' })

    expect(readReleaseRoute(dir)).toEqual({ dir, route: 'versioning', pending: ['plain-eels-shake.md'] })
  })

  it('reads a real directory with nothing pending as publishing', () => {
    const dir = changesetDir({ 'README.md': '', 'config.json': '{}' })

    expect(readReleaseRoute(dir)).toEqual({ dir, route: 'publishing', pending: [] })
  })

  it('reads an absent directory as unknown, never as a tree with nothing pending', () => {
    const dir = path.join(tmpdir(), 'construct-changeset-absent-directory')
    const reading = readReleaseRoute(dir)

    expect(reading).toEqual({ dir, route: 'unknown', pending: [] })
    expect(reading.route).not.toBe('publishing')
  })
})

const changeset = (bump: string, pkg = 'mikoshi-construct'): string => `---\n"${pkg}": ${bump}\n---\n\nA change.\n`

describe('the version changesets will release is read once, from main and the version pull request', () => {
  it('with no version PR the release version is main raised by the highest pending bump', () => {
    expect(releaseVersionFrom({ versionPr: null, main: '0.45.1', pending: [changeset('patch'), changeset('minor'), changeset('patch')] })).toBe('0.46.0')
    expect(releaseVersionFrom({ versionPr: null, main: '0.45.1', pending: [changeset('patch')] })).toBe('0.45.2')
    expect(releaseVersionFrom({ versionPr: null, main: '0.45.1', pending: [changeset('minor'), changeset('major')] })).toBe('1.0.0')
  })

  it('with an open version PR the release version is its package.json version', () => {
    expect(releaseVersionFrom({ versionPr: '0.46.0', main: '0.45.1', pending: [changeset('patch')] })).toBe('0.46.0')
    expect(releaseVersionFrom({ versionPr: '0.45.2', main: '0.45.1', pending: [changeset('minor')] })).toBe('0.45.2')
  })

  it('reads a version PR branch that main already released as no open version PR', () => {
    expect(releaseVersionFrom({ versionPr: '0.45.1', main: '0.45.1', pending: [changeset('minor')] })).toBe('0.46.0')
  })

  it('reads a leftover version PR branch below main\'s version as no open version PR', () => {
    expect(releaseVersionFrom({ versionPr: '0.45.1', main: '0.46.0', pending: [changeset('minor')] })).toBe('0.47.0')
    expect(releaseVersionFrom({ versionPr: '0.9.9', main: '0.10.0', pending: [] })).toBe('0.10.0')
    expect(releaseVersionFrom({ versionPr: '0.10.0', main: '0.9.9', pending: [] })).toBe('0.10.0')
  })

  it('with nothing pending the release version is main\'s own, and a changeset naming another package or no bump raises nothing', () => {
    expect(releaseVersionFrom({ versionPr: null, main: '0.45.1', pending: [] })).toBe('0.45.1')
    expect(releaseVersionFrom({ versionPr: null, main: '0.45.1', pending: [changeset('major', 'other'), '---\n---\n'] })).toBe('0.45.1')
  })

  it('reads the bump of the package from a changeset front matter, quoted or bare', () => {
    expect(bumpOf(changeset('minor'))).toBe('minor')
    expect(bumpOf('---\nmikoshi-construct: major\n---\n')).toBe('major')
    expect(bumpOf('---\n"mikoshi-construct": huge\n---\n')).toBeNull()
    expect(bumpOf('"mikoshi-construct": minor\n')).toBeNull()
  })

  it('raises a version by one bump and resets the parts below it', () => {
    expect(raisedVersion('0.45.1', 'patch')).toBe('0.45.2')
    expect(raisedVersion('0.45.1', 'minor')).toBe('0.46.0')
    expect(raisedVersion('0.45.1', 'major')).toBe('1.0.0')
  })

  it('fetches origin before it reads, and a version branch main has moved past since, as a version PR closed unmerged leaves it, is no open version PR', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'construct-release-version-'))
    const [origin, work, reader] = ['origin.git', 'work', 'reader'].map(name => path.join(scratch, name)) as [string, string, string]
    const git = (repo: string, ...args: string[]): void => {
      expect(spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).status).toBe(0)
    }
    const commit = (version: string, files: Record<string, string>): void => {
      writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'mikoshi-construct', version }))
      for (const [name, body] of Object.entries(files))
        writeFileSync(path.join(work, '.changeset', name), body)
      git(work, 'add', '-A')
      git(work, 'commit', '-q', '-m', version)
    }
    git(scratch, 'init', '-q', '--bare', origin)
    git(scratch, 'init', '-q', '-b', 'main', work)
    git(work, 'remote', 'add', 'origin', origin)
    git(scratch, 'init', '-q', reader)
    git(reader, 'remote', 'add', 'origin', origin)
    expect(readReleaseVersion(gitIn(reader))).toBeNull()
    mkdirSync(path.join(work, '.changeset'))
    commit('0.45.1', { 'README.md': '', 'config.json': '{}', 'olive-pugs-repeat.md': changeset('minor'), 'plain-eels-shake.md': changeset('patch') })
    git(work, 'push', '-q', 'origin', 'main')
    expect(readReleaseVersion(gitIn(reader))).toBe('0.46.0')
    git(work, 'checkout', '-q', '-b', 'changeset-release/main')
    git(work, 'rm', '-q', '.changeset/olive-pugs-repeat.md', '.changeset/plain-eels-shake.md')
    commit('0.46.0', {})
    git(work, 'push', '-q', 'origin', 'changeset-release/main')
    expect(readReleaseVersion(gitIn(reader))).toBe('0.46.0')
    git(work, 'checkout', '-q', 'main')
    git(work, 'rm', '-q', '.changeset/olive-pugs-repeat.md')
    commit('0.45.1', {})
    git(work, 'push', '-q', 'origin', 'main')
    expect(readReleaseVersion(gitIn(reader))).toBe('0.45.2')
    git(work, 'push', '-q', 'origin', '--delete', 'changeset-release/main')
    expect(readReleaseVersion(gitIn(reader))).toBe('0.45.2')
  })
})
