import type { ReleaseVersions } from '../../release/version-pr-guard.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { PLAN_OPENED } from '../../core/events.js'
import { guardVersionPr, planVersionOnBus, releaseVersionOfPlan } from '../../release/version-pr-guard.js'

const NO_PLAN: ReleaseVersions = { plan: null, release: '0.46.0' }

function changesetDir(files: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-version-pr-'))
  for (const name of files)
    writeFileSync(path.join(dir, name), '')
  return dir
}

describe('a version pull request cannot merge over a changeset it has not consumed', () => {
  it('refuses changeset-release/main while the merged tree carries a pending changeset, naming it and what to do', () => {
    const dir = changesetDir(['README.md', 'config.json', 'olive-pugs-repeat.md'])

    const verdict = guardVersionPr('changeset-release/main', NO_PLAN, dir)

    expect(verdict.passed).toBe(false)
    const text = verdict.lines.join('\n')
    expect(text).toContain(`${dir}/olive-pugs-repeat.md`)
    expect(text).not.toContain('README.md')
    expect(text).toMatch(/wait for the release bot to update the version pull request/)
  })

  it('names every pending changeset, not only the first', () => {
    const dir = changesetDir(['config.json', 'olive-pugs-repeat.md', 'ninety-nine-moles-sit.md'])

    const text = guardVersionPr('changeset-release/main', NO_PLAN, dir).lines.join('\n')

    expect(text).toContain('olive-pugs-repeat.md')
    expect(text).toContain('ninety-nine-moles-sit.md')
  })

  it('passes changeset-release/main once every changeset is consumed', () => {
    expect(guardVersionPr('changeset-release/main', NO_PLAN, changesetDir(['README.md', 'config.json'])).passed).toBe(true)
  })

  it('passes any other branch carrying a pending changeset, which is the ordinary feature pull request', () => {
    expect(guardVersionPr('version-pr-guard', NO_PLAN, changesetDir(['config.json', 'olive-pugs-repeat.md'])).passed).toBe(true)
  })

  it('passes a run with no pull request head, as push and merge_group runs have', () => {
    expect(guardVersionPr(undefined, NO_PLAN, changesetDir(['olive-pugs-repeat.md'])).passed).toBe(true)
    expect(guardVersionPr('', NO_PLAN, changesetDir(['olive-pugs-repeat.md'])).passed).toBe(true)
  })
})

describe('a version pull request publishes the version its plan sets', () => {
  const consumed = (): string => changesetDir(['README.md', 'config.json'])

  it('a version PR whose version differs from the plan version is red', () => {
    const verdict = guardVersionPr('changeset-release/main', { plan: { plan: 'factory-0.46', version: '0.46' }, release: '0.45.1' }, consumed())

    expect(verdict.passed).toBe(false)
    const text = verdict.lines.join('\n')
    expect(text).toContain('versions 0.45.1, but plan factory-0.46 sets 0.46.0')
    expect(text).toMatch(/Do not merge: make the release changeset bump to 0\.46\.0/)
  })

  it('passes a version PR whose version is the plan version, written short or full', () => {
    expect(guardVersionPr('changeset-release/main', { plan: { plan: 'factory-0.46', version: '0.46' }, release: '0.46.0' }, consumed()).passed).toBe(true)
    expect(guardVersionPr('changeset-release/main', { plan: { plan: 'factory-0.45.2', version: '0.45.2' }, release: '0.45.2' }, consumed()).passed).toBe(true)
  })

  it('passes a version PR when no plan on the bus carries a version, saying the version went unchecked', () => {
    const verdict = guardVersionPr('changeset-release/main', NO_PLAN, consumed())

    expect(verdict.passed).toBe(true)
    expect(verdict.lines.join('\n')).toContain('0.46.0 is not checked against a plan')
  })

  it('leaves a version mismatch unread while a changeset is still pending, and every other branch alone', () => {
    const plan = { plan: { plan: 'factory-0.46', version: '0.46' }, release: '0.45.1' }
    expect(guardVersionPr('changeset-release/main', plan, changesetDir(['olive-pugs-repeat.md'])).lines.join('\n')).toContain('olive-pugs-repeat.md')
    expect(guardVersionPr('version-pr-guard', plan, consumed()).passed).toBe(true)
  })

  it('maps a plan version to the release version: minor gains .0, a full or v-prefixed version keeps its numbers', () => {
    expect(releaseVersionOfPlan('0.46')).toBe('0.46.0')
    expect(releaseVersionOfPlan('v0.47')).toBe('0.47.0')
    expect(releaseVersionOfPlan('0.45.2')).toBe('0.45.2')
  })

  it('reads the version of the latest owner plan.opened that carries one, and nothing from a missing bus', () => {
    const busPath = path.join(mkdtempSync(path.join(tmpdir(), 'construct-plan-version-')), 'bus.db')
    expect(planVersionOnBus(busPath)).toBeNull()
    const db = openBus(busPath)
    const opened = (key: string, actor: string, payload: Record<string, unknown>): void => {
      appendEvent(db, { ts: '2026-11-02T00:00:00.000Z', type: PLAN_OPENED, actor, cardId: null, pr: null, head: null, dedupeKey: key, payload, legacy: false })
    }
    opened('a', 'owner', { id: 'factory-0.46', version: '0.46' })
    opened('b', 'owner', { id: 'factory-0.47' })
    opened('c', 'worker:window:s', { id: 'factory-0.48', version: '0.48' })
    db.close()

    expect(planVersionOnBus(busPath)).toEqual({ plan: 'factory-0.46', version: '0.46' })
  })
})
