import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pendingChangesets, readReleaseRoute, routeFrom } from '../../release/changesets.js'

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
