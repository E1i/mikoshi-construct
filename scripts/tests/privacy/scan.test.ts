import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALLOWED_DOMAINS } from '../../privacy/allowlist.js'
import { formatViolation, SCANNED_PATHS, scannedFiles, scanRepository, scanText } from '../../privacy/scan.js'

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES, `${name}.md`), 'utf8')
}

describe('privacy guard', () => {
  it('reports no violation for templates, docs and README on the working tree', () => {
    expect(scanRepository().map(formatViolation)).toEqual([])
  })

  it('never scans the bait it uses to prove itself', () => {
    expect(scannedFiles().some(file => file.startsWith('scripts/tests/privacy/fixtures'))).toBe(false)
  })

  it('scans the test fixtures, where frozen manifests from other repositories live', () => {
    expect(SCANNED_PATHS).toEqual(['templates', 'docs', 'README.md', 'tests/fixtures'])
    expect(scannedFiles().some(file => file.startsWith('tests/fixtures/manifests/'))).toBe(true)
  })

  it('fails a fixture whose domain is not in the allowlist, naming file and domain', () => {
    const messages = scanText(readFixture('unlisted-domain'), 'unlisted-domain.md').map(formatViolation)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('unlisted-domain.md')
    expect(messages[0]).toContain('tracker.example-analytics.io')
  })

  it('fails a fixture carrying /Users, /home and ~ home directory paths, naming each path', () => {
    const messages = scanText(readFixture('home-paths'), 'home-paths.md').map(formatViolation)
    expect(messages).toHaveLength(3)
    expect(messages[0]).toContain('/Users/somebody')
    expect(messages[1]).toContain('/home/somebody')
    expect(messages[2]).toContain('~/somebody-notes')
  })

  it('fails when a new unlisted domain is introduced into a scanned file', () => {
    const scanned = scannedFiles()[0]
    const text = `${readFileSync(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'), scanned), 'utf8')}\nsee https://leak.acme-internal.dev/docs\n`
    expect(scanText(text, scanned).map(formatViolation).join('\n')).toContain('leak.acme-internal.dev')
  })

  it('fails a URL host whose top-level domain is outside the mentioned-host list', () => {
    const messages = scanText('see https://acme-internal.ru/docs for the runbook', 'probe.md').map(formatViolation)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('acme-internal.ru')
  })

  it('fails an email host outside the allowlist and leaves a version specifier alone', () => {
    const messages = scanText('write to owner@corp.de about eslint@9.5.1', 'probe.md').map(formatViolation)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('corp.de')
  })

  it('allows the always-permitted hosts and every listed domain', () => {
    const text = ALLOWED_DOMAINS.map(domain => `https://${domain}/x`).join('\n')
    expect(scanText(text, 'allowlist.md')).toEqual([])
  })
})
