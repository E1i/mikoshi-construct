import { describe, expect, it } from 'vitest'
import { callsBrowserWitness, VERIFICATION_WORDS } from '../../core/verification.js'

const CALLED = 'Acceptance: no horizontal scroll at 375 — witness: `node scripts/construct/browser-witness.mjs --serve \'pnpm dev --port {port}\' --page / --at 375 --no-hscroll`; the build is green — witness: `pnpm build`'
const DESIGN_ONLY = 'Design:\n- the carrier scripts/construct/browser-witness.mjs is untouched\n\nAcceptance: the build is green — witness: `pnpm build`'
const OTHER_WITNESS = 'Acceptance: the page renders — witness: `pnpm exec playwright test`'

describe('the browser verification class is derived from the witnesses of a ladder brief', () => {
  it('knows browser as a verification word', () => {
    expect(VERIFICATION_WORDS).toContain('browser')
  })

  it.each([
    [CALLED, true],
    [DESIGN_ONLY, false],
    [OTHER_WITNESS, false],
    ['', false],
  ])('callsBrowserWitness(%j) is %s', (text, expected) => {
    expect(callsBrowserWitness(text)).toBe(expected)
  })
})
