import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { approvedHashPath, canonicalImplementText, checkApproval, extractApprovedHash, extractImplementText, implementLineNumbers, sha256Hex } from '../../ghosts/approval.js'

function worldDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ghosts-approval-'))
}

const BRIEF = `# Brief g1 (fixture)

Some prose before the marker.

---

/implement Ghost g1: print \`hello\`.

Design:
- a line
`

describe('extractImplementText', () => {
  it('slices from the first line starting with /implement to the end of the file', () => {
    expect(extractImplementText(BRIEF)).toBe(BRIEF.slice(BRIEF.indexOf('/implement')))
  })

  it('is undefined when the brief has no /implement line', () => {
    expect(extractImplementText('# Brief\n\nno marker here\n')).toBeUndefined()
  })
})

describe('canonicalImplementText', () => {
  it('drops every trailing newline from extractImplementText, keeping the last line', () => {
    const content = '# head\n\n---\n\n/implement one\n\nlast\n\n\n'
    expect(extractImplementText(content)).toBe('/implement one\n\nlast\n\n\n')
    expect(canonicalImplementText(content)).toBe('/implement one\n\nlast')
  })

  it('is undefined when the brief has no /implement line', () => {
    expect(canonicalImplementText('# Brief\n\nno marker here\n')).toBeUndefined()
  })
})

describe('implementLineNumbers', () => {
  it('is empty for a brief with no /implement line', () => {
    expect(implementLineNumbers('# Brief\n\nno marker here\n')).toEqual([])
  })

  it('is the 1-based line number of the single /implement line', () => {
    expect(implementLineNumbers(BRIEF)).toEqual([BRIEF.slice(0, BRIEF.indexOf('/implement')).split('\n').length])
  })

  it('names every line starting with /implement, in order', () => {
    const content = '/implement first\nprose\n/implement second\n'
    expect(implementLineNumbers(content)).toEqual([1, 3])
  })
})

describe('extractApprovedHash', () => {
  it('reads the first 64 hex characters after sha256:', () => {
    const hash = sha256Hex('x')
    expect(extractApprovedHash(`approved /implement text sha256: ${hash} (2026-09-27, world)\n`)).toBe(hash)
  })

  it('is undefined without a sha256: hash', () => {
    expect(extractApprovedHash('nothing to see here\n')).toBeUndefined()
  })
})

describe('approvedHashPath', () => {
  it('replaces the .md suffix with .approved-sha256', () => {
    expect(approvedHashPath('/w/handoff/brief-g1.md')).toBe('/w/handoff/brief-g1.approved-sha256')
  })
})

describe('checkApproval', () => {
  it('approves a brief whose text matches its recorded hash', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief-g1.md')
    writeFileSync(brief, BRIEF)
    writeFileSync(approvedHashPath(brief), `approved /implement text sha256: ${sha256Hex(canonicalImplementText(BRIEF)!)} (2026-09-27, world)\n`)

    const result = checkApproval(brief)
    expect(result.ok).toBe(true)
    expect(result.ok && result.text).toBe(canonicalImplementText(BRIEF))
  })

  it('approves a brief that gained trailing newlines after approval', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief-g1.md')
    writeFileSync(brief, BRIEF)
    writeFileSync(approvedHashPath(brief), `approved /implement text sha256: ${sha256Hex(canonicalImplementText(BRIEF)!)} (2026-09-27, world)\n`)

    writeFileSync(brief, `${BRIEF}\n\n\n`)

    const result = checkApproval(brief)
    expect(result.ok).toBe(true)
    expect(result.ok && result.text).toBe(canonicalImplementText(BRIEF))
  })

  it('refuses a brief with more than one /implement line, naming both line numbers', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief-g1.md')
    const content = '/implement first\nprose\n/implement second\n'
    writeFileSync(brief, content)
    writeFileSync(approvedHashPath(brief), `approved /implement text sha256: ${sha256Hex(canonicalImplementText(content)!)} (2026-09-27, world)\n`)

    const result = checkApproval(brief)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain(brief)
      expect(result.reason).toContain('1')
      expect(result.reason).toContain('3')
    }
  })

  it('refuses a brief with no approval file, naming the brief', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief-g1.md')
    writeFileSync(brief, BRIEF)

    const result = checkApproval(brief)
    expect(result.ok).toBe(false)
    expect(result.ok || result.reason).toContain(brief)
    expect(result.ok || result.reason.toLowerCase()).toContain('no approval')
  })

  it('refuses a brief with no hash in the approval file', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief-g1.md')
    writeFileSync(brief, BRIEF)
    writeFileSync(approvedHashPath(brief), 'no hash here\n')

    const result = checkApproval(brief)
    expect(result.ok).toBe(false)
    expect(result.ok || result.reason.toLowerCase()).toContain('no approval')
  })

  it('refuses a brief whose text was changed after approval, naming both hashes', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief-g1.md')
    const approvedHash = sha256Hex(canonicalImplementText(BRIEF)!)
    writeFileSync(brief, BRIEF)
    writeFileSync(approvedHashPath(brief), `approved /implement text sha256: ${approvedHash} (2026-09-27, world)\n`)

    const tampered = BRIEF.replace('Ghost g1:', 'Ghost g2:')
    writeFileSync(brief, tampered)

    const result = checkApproval(brief)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain(brief)
      expect(result.reason).toContain(approvedHash)
      expect(result.reason).toContain(sha256Hex(canonicalImplementText(tampered)!))
    }
  })
})
