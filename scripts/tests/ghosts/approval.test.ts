import type { Preflight } from '../../ghosts/preflight.js'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { approvalOf, approvalSha256, approvedHashPath, canonicalImplementText, checkApproval, extractApprovedHash, extractApprovedSketch, extractImplementText, implementLineNumbers, journalEvents, morseApprovalOf, morseCarryOf, sha256Hex, withoutSketchLine } from '../../ghosts/approval.js'
import { morseApprove } from '../../ghosts/hash.js'

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
    expect(extractApprovedHash(`approved /implement text sha256: ${hash} sketch: none (2026-09-27, world)\n`)).toBe(hash)
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
    writeFileSync(approvedHashPath(brief), `approved /implement text sha256: ${approvalSha256(canonicalImplementText(BRIEF)!)} sketch: none (2026-09-27, world)\n`)

    const result = checkApproval(brief)
    expect(result.ok).toBe(true)
    expect(result.ok && result.text).toBe(canonicalImplementText(BRIEF))
    expect(result.ok && result.sha256).toBe(approvalSha256(canonicalImplementText(BRIEF)!))
    expect(result.ok && result.approvedSketch).toBe('none')
  })

  it('approves a brief that gained trailing newlines after approval', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief-g1.md')
    writeFileSync(brief, BRIEF)
    writeFileSync(approvedHashPath(brief), `approved /implement text sha256: ${approvalSha256(canonicalImplementText(BRIEF)!)} sketch: none (2026-09-27, world)\n`)

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
    writeFileSync(approvedHashPath(brief), `approved /implement text sha256: ${approvalSha256(canonicalImplementText(content)!)} sketch: none (2026-09-27, world)\n`)

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
    const approvedHash = approvalSha256(canonicalImplementText(BRIEF)!)
    writeFileSync(brief, BRIEF)
    writeFileSync(approvedHashPath(brief), `approved /implement text sha256: ${approvedHash} sketch: none (2026-09-27, world)\n`)

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

const SKETCH_SHA = 'a'.repeat(40)
const SKETCHED = `/implement x\nSketch: sketch/t @ ${SKETCH_SHA}\n\nDesign:\n- a line`

describe('withoutSketchLine', () => {
  it('drops line 2 when it is the Sketch: line and nothing else', () => {
    expect(withoutSketchLine(SKETCHED)).toBe('/implement x\n\nDesign:\n- a line')
    expect(withoutSketchLine('/implement x\nSketch: none \u2014 r\n\nDesign')).toBe('/implement x\n\nDesign')
    expect(withoutSketchLine('/implement x\n\nSketch: none \u2014 late')).toBe('/implement x\n\nSketch: none \u2014 late')
  })

  it('leaves the approval hash alone when only the sketch sha changes, and moves it when the Design changes', () => {
    const rebased = SKETCHED.replace(SKETCH_SHA, 'b'.repeat(40))
    expect(approvalSha256(rebased)).toBe(approvalSha256(SKETCHED))
    expect(approvalSha256(SKETCHED.replace('a line', 'another line'))).not.toBe(approvalSha256(SKETCHED))
    expect(sha256Hex(rebased)).not.toBe(sha256Hex(SKETCHED))
  })
})

describe('extractApprovedSketch', () => {
  it('reads the 40-hex sha or none after sketch:, and nothing from the earlier note form', () => {
    expect(extractApprovedSketch(`approved /implement text sha256: ${'c'.repeat(64)} sketch: ${SKETCH_SHA} (2026-10-04, E)`)).toBe(SKETCH_SHA)
    expect(extractApprovedSketch(`approved /implement text sha256: ${'c'.repeat(64)} sketch: none (2026-10-04, E)`)).toBe('none')
    expect(extractApprovedSketch(`approved /implement text sha256: ${'c'.repeat(64)} (2026-09-27, E; sketch 1234567)`)).toBeUndefined()
    expect(extractApprovedSketch(`sketch: ${'d'.repeat(7)}`)).toBeUndefined()
  })
})

describe('checkApproval on an approval written by the earlier rule', () => {
  it('refuses with re-approve, even when the earlier hash of the whole text matches', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief-g1.md')
    writeFileSync(brief, SKETCHED)
    writeFileSync(approvedHashPath(brief), `approved /implement text sha256: ${sha256Hex(SKETCHED)} (2026-09-27, world; sketch aaaaaaa)\n`)

    const result = checkApproval(brief)
    expect(result.ok).toBe(false)
    expect(result.ok || result.reason).toContain('re-approve')
    expect(result.ok || result.reason).toContain(brief)
  })

  it('approves the sketch-free hash with the sha beside it, whatever the Sketch: line now says', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief-g1.md')
    writeFileSync(brief, SKETCHED.replace(SKETCH_SHA, 'b'.repeat(40)))
    writeFileSync(approvedHashPath(brief), `approved /implement text sha256: ${approvalSha256(SKETCHED)} sketch: ${SKETCH_SHA} (2026-10-04, world)\n`)

    const result = checkApproval(brief)
    expect(result.ok && result.approvedSketch).toBe(SKETCH_SHA)
  })
})

describe('approvalOf', () => {
  const events = [{ event: 'approval', by: 'owner', card: 7, sha256: 'a' }, { event: 'approval', by: 'morse', card: 7, sha256: 'b' }, { event: 'revoke', card: 7, sha256: 'c' }]

  it('finds an approval of the card and the hash by any approver, and no other event', () => {
    expect(approvalOf(events, 'a', 7)).toBe(events[0])
    expect(approvalOf(events, 'b', 7)).toBe(events[1])
    expect(approvalOf(events, 'c', 7)).toBeUndefined()
    expect(approvalOf(events, 'a', 8)).toBeUndefined()
  })

  it('is what morseApprovalOf narrows to the approvals by morse', () => {
    expect(morseApprovalOf(events, 'a', 7)).toBeUndefined()
    expect(morseApprovalOf(events, 'b', 7)).toBe(events[1])
  })
})

const CARRY_CARD = 902
const APPROVED_SKETCH = 'a'.repeat(40)
const REBASED_SKETCH = 'b'.repeat(40)

function sketchedText(sketch: string, steps = 'Print the name.'): string {
  return `/implement ${steps}\nSketch: sketch/t @ ${sketch}\nexpect: tokens ≈ 166k, minutes ≈ 12 — effort medium, n=61, median, p25–p75 100k–200k\n\nAcceptance: the name is printed — witness: \`echo name\``
}

function carryWorld(): { brief: string, approvedPath: string, journalPath: string, approve: (preflight?: Preflight) => Promise<string> } {
  const dir = worldDir()
  const brief = path.join(dir, 'brief-t.md')
  writeFileSync(brief, `# head\n\n---\n\n${sketchedText(APPROVED_SKETCH)}\n`)
  const parkingDir = path.join(dir, 'parking')
  mkdirSync(parkingDir)
  writeFileSync(path.join(parkingDir, `${CARRY_CARD}.md`), parkingFileText({ card: `#${CARRY_CARD} task-${CARRY_CARD} [implement/ghosts/S/cheap/owner] · depends — · blocks —`, branch: `feat/${CARRY_CARD}`, touches: ['src/thing/**'], continue: 'stop', who: 'shift', body: 'Do the thing.' }))
  const journalPath = path.join(dir, 'ghosts.jsonl')
  writeFileSync(journalPath, '')
  const approve = async (preflight: Preflight = () => {}): Promise<string> => (await morseApprove(brief, { card: CARRY_CARD, parkingDir, journalPath, now: new Date(2026, 9, 9, 12), runBuild: () => ({ status: 0, stderr: '' }), preflight })).line
  return { brief, approvedPath: approvedHashPath(brief), journalPath, approve }
}

function approvalsIn(journalPath: string): Record<string, unknown>[] {
  return journalEvents(journalPath).filter(event => event.event === 'approval')
}

describe('a MORSE approval after a rebase of its sketch', () => {
  it('a MORSE approval carries to a cleanly rebased sketch with the same text and a green preflight', async () => {
    const world = carryWorld()
    await world.approve()
    const sha256 = approvalSha256(sketchedText(APPROVED_SKETCH))
    writeFileSync(world.brief, `# head\n\n---\n\n${sketchedText(REBASED_SKETCH)}\n`)
    const preflight = vi.fn<Preflight>()

    const line = await world.approve(preflight)

    expect(preflight).toHaveBeenCalledTimes(1)
    expect(line).toBe(`approved /implement text sha256: ${sha256} sketch: ${REBASED_SKETCH} (2026-10-09, morse)`)
    expect(readFileSync(world.approvedPath, 'utf8')).toBe(`${line}\n`)
    expect(checkApproval(world.brief)).toMatchObject({ ok: true, sha256, approvedSketch: REBASED_SKETCH })
    const approvals = approvalsIn(world.journalPath)
    expect(approvals).toHaveLength(2)
    expect(approvals[1]).toMatchObject({ by: 'morse', card: CARRY_CARD, sha256, sketch: REBASED_SKETCH, carriedFrom: APPROVED_SKETCH })
    expect(approvals[1]!.reason).toContain('carried from sketch aaaaaaa with the same text')
  })

  it('a red preflight on the rebased sketch carries nothing and writes nothing', async () => {
    const world = carryWorld()
    await world.approve()
    const approvedBefore = readFileSync(world.approvedPath, 'utf8')
    const journalBefore = readFileSync(world.journalPath, 'utf8')
    writeFileSync(world.brief, `# head\n\n---\n\n${sketchedText(REBASED_SKETCH)}\n`)

    await expect(world.approve(() => {
      throw new Error('preflight P7: the witness is green on the base')
    })).rejects.toThrow('preflight P7')

    expect(readFileSync(world.approvedPath, 'utf8')).toBe(approvedBefore)
    expect(readFileSync(world.journalPath, 'utf8')).toBe(journalBefore)
  })

  it('the same sketch has nothing to carry and is left as it is', async () => {
    const world = carryWorld()
    const line = await world.approve()

    await expect(world.approve()).rejects.toThrow(/nothing to carry/)
    expect(readFileSync(world.approvedPath, 'utf8')).toBe(`${line}\n`)
    expect(approvalsIn(world.journalPath)).toHaveLength(1)
  })
})

describe('morseCarryOf', () => {
  const sha256 = approvalSha256(sketchedText(APPROVED_SKETCH))
  const morseLine = `approved /implement text sha256: ${sha256} sketch: ${APPROVED_SKETCH} (2026-10-09, morse)\n`
  const events = [{ event: 'approval', by: 'morse', card: CARRY_CARD, sha256 }]

  it('a changed implement text carries no approval', () => {
    const changed = approvalSha256(sketchedText(REBASED_SKETCH, 'Print the name twice.'))

    expect(changed).not.toBe(sha256)
    expect(morseCarryOf(morseLine, changed, REBASED_SKETCH, events, CARRY_CARD)).toEqual({ kind: 'fresh' })
  })

  it('carries a morse approval of the same text to another sketch, and nothing else', () => {
    expect(morseCarryOf(morseLine, sha256, REBASED_SKETCH, events, CARRY_CARD)).toEqual({ kind: 'carry', from: APPROVED_SKETCH })
    expect(morseCarryOf(undefined, sha256, REBASED_SKETCH, events, CARRY_CARD)).toEqual({ kind: 'fresh' })
    expect(morseCarryOf(morseLine, sha256, REBASED_SKETCH, [], CARRY_CARD)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('holds no approval event by morse') })
    expect(morseCarryOf(morseLine.replace('morse', 'Eli'), sha256, REBASED_SKETCH, events, CARRY_CARD)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('approved by Eli') })
  })
})
