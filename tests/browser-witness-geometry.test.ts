import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts/construct/browser-witness.mjs')

interface Rect { left: number, right: number, top: number, bottom: number }

interface Element extends Rect {
  width: number
  height: number
  display: string
  visibility: string
  attribute: string | null
}

interface Assertion {
  kind: string
  selectors: string[]
  name?: string
  value?: string
}

interface Observed {
  innerWidth: number
  scrollWidth: number
  groups: Element[][]
}

interface Verdict { holds: boolean, detail: string }

interface Options {
  serve: string
  pages: string[]
  widths: number[]
  assertions: Assertion[]
  shots: string
  readyTimeoutSeconds: number
}

interface BrowserWitness {
  exceedsViewport: (measured: { scrollWidth: number, innerWidth: number }) => boolean
  insideInline: (rect: Rect, innerWidth: number) => boolean
  overlaps: (a: Rect, b: Rect) => boolean
  isVisible: (element: Element) => boolean
  judge: (assertion: Assertion, observed: Observed) => Verdict
  parseArguments: (argv: string[]) => Options
  UsageError: new () => Error
}

const { exceedsViewport, insideInline, judge, isVisible, overlaps, parseArguments, UsageError } = await import(pathToFileURL(SCRIPT).href) as BrowserWitness

function rect(left: number, top: number, right: number, bottom: number): Rect {
  return { left, top, right, bottom }
}

function element(box: Rect, extra: Partial<Element> = {}): Element {
  return { ...box, width: box.right - box.left, height: box.bottom - box.top, display: 'block', visibility: 'visible', attribute: null, ...extra }
}

function observed(groups: Element[][], innerWidth = 375): Observed {
  return { innerWidth, scrollWidth: innerWidth, groups }
}

describe('scroll comparison', () => {
  it.each([
    [412, 375, true],
    [376, 375, true],
    [375, 375, false],
    [320, 375, false],
  ])('scrollWidth %i against innerWidth %i exceeds: %s', (scrollWidth, innerWidth, expected) => {
    expect(exceedsViewport({ scrollWidth, innerWidth })).toBe(expected)
  })
})

describe('a rect inside the viewport on the inline axis', () => {
  it.each([
    [rect(0, 0, 375, 10), true],
    [rect(10, 0, 100, 10), true],
    [rect(-1, 0, 100, 10), false],
    [rect(300, 0, 376, 10), false],
    [rect(0, 0, 375.004, 10), true],
    [rect(-0.004, 0, 100, 10), true],
    [rect(0, -50, 100, 900), true],
  ])('%j at width 375: %s', (box, expected) => {
    expect(insideInline(box, 375)).toBe(expected)
  })
})

describe('rect intersection', () => {
  it.each([
    [rect(10, 10, 110, 110), rect(60, 60, 160, 160), true],
    [rect(10, 10, 110, 110), rect(110, 10, 210, 110), false],
    [rect(10, 10, 110, 110), rect(10, 110, 110, 210), false],
    [rect(10, 10, 110, 110), rect(30, 30, 50, 50), true],
    [rect(10, 10, 110, 110), rect(200, 200, 300, 300), false],
  ])('%j and %j overlap: %s', (a, b, expected) => {
    expect(overlaps(a, b)).toBe(expected)
    expect(overlaps(b, a)).toBe(expected)
  })
})

describe('visibility', () => {
  it('needs a box, a display and a visibility', () => {
    const box = rect(0, 0, 10, 10)
    expect(isVisible(element(box))).toBe(true)
    expect(isVisible(element(rect(0, 0, 0, 10)))).toBe(false)
    expect(isVisible(element(rect(0, 0, 10, 0)))).toBe(false)
    expect(isVisible(element(box, { display: 'none' }))).toBe(false)
    expect(isVisible(element(box, { visibility: 'hidden' }))).toBe(false)
  })
})

describe('judging an assertion against what was observed', () => {
  const box = element(rect(10, 10, 110, 110))

  it('reports the measured values of a scroll that is too wide, and holds at exactly the viewport width', () => {
    const noHscroll = { kind: 'no-hscroll', selectors: [] }
    expect(judge(noHscroll, { innerWidth: 375, scrollWidth: 412, groups: [] })).toEqual({ holds: false, detail: 'scrollWidth=412 > innerWidth=375' })
    expect(judge(noHscroll, { innerWidth: 375, scrollWidth: 375, groups: [] }).holds).toBe(true)
  })

  it.each(['inside', 'visible', 'hidden', 'attr'])('fails %s on a selector that matches nothing', (kind) => {
    const verdict = judge({ kind, selectors: ['.nope'], name: 'x' }, observed([[]]))
    expect(verdict).toEqual({ holds: false, detail: '.nope matches 0 elements' })
  })

  it('fails no-overlap when either selector matches nothing', () => {
    const assertion = { kind: 'no-overlap', selectors: ['#a', '#b'] }
    expect(judge(assertion, observed([[box], []]))).toEqual({ holds: false, detail: '#b matches 0 elements' })
    expect(judge(assertion, observed([[], [box]]))).toEqual({ holds: false, detail: '#a matches 0 elements' })
  })

  it('fails no-overlap on an intersection and holds on touching edges', () => {
    const assertion = { kind: 'no-overlap', selectors: ['#a', '#b'] }
    expect(judge(assertion, observed([[box], [element(rect(60, 60, 160, 160))]])).holds).toBe(false)
    expect(judge(assertion, observed([[box], [element(rect(110, 10, 210, 110))]])).holds).toBe(true)
  })

  it('fails inside when any matched element leaves the viewport', () => {
    const assertion = { kind: 'inside', selectors: ['.card'] }
    expect(judge(assertion, observed([[box, element(rect(-50, 0, 50, 10))]])).holds).toBe(false)
    expect(judge(assertion, observed([[box]])).holds).toBe(true)
  })

  it('compares an attribute by presence, or by value when one is given', () => {
    const open = element(rect(0, 0, 1, 1), { attribute: 'false' })
    expect(judge({ kind: 'attr', selectors: ['#menu'], name: 'aria-expanded', value: undefined }, observed([[open]])).holds).toBe(true)
    expect(judge({ kind: 'attr', selectors: ['#menu'], name: 'aria-expanded', value: 'false' }, observed([[open]])).holds).toBe(true)
    expect(judge({ kind: 'attr', selectors: ['#menu'], name: 'aria-expanded', value: 'true' }, observed([[open]])).holds).toBe(false)
    expect(judge({ kind: 'attr', selectors: ['#menu'], name: 'aria-expanded' }, observed([[element(rect(0, 0, 1, 1))]])).holds).toBe(false)
  })

  it('holds visible and hidden only when every matched element agrees', () => {
    const gone = element(rect(0, 0, 0, 0), { display: 'none' })
    expect(judge({ kind: 'visible', selectors: ['x'] }, observed([[box, gone]])).holds).toBe(false)
    expect(judge({ kind: 'hidden', selectors: ['x'] }, observed([[box, gone]])).holds).toBe(false)
    expect(judge({ kind: 'visible', selectors: ['x'] }, observed([[box]])).holds).toBe(true)
    expect(judge({ kind: 'hidden', selectors: ['x'] }, observed([[gone]])).holds).toBe(true)
  })
})

describe('the arguments', () => {
  const base = ['--serve', 'node s.mjs {port}', '--page', '/a']

  it('reads pages, widths and every assertion form, and defaults the widths to 375, 768 and 1280', () => {
    const options = parseArguments([...base, '--page', '/b', '--no-hscroll', '--inside', '.card', '--no-overlap', '#a', '#b', '--attr', '#m', 'aria-expanded=false', '--visible', '#a', '--hidden', '#m'])
    expect(options.pages).toEqual(['/a', '/b'])
    expect(options.widths).toEqual([375, 768, 1280])
    expect(options.assertions).toEqual([
      { kind: 'no-hscroll', selectors: [] },
      { kind: 'inside', selectors: ['.card'] },
      { kind: 'no-overlap', selectors: ['#a', '#b'] },
      { kind: 'attr', selectors: ['#m'], name: 'aria-expanded', value: 'false' },
      { kind: 'visible', selectors: ['#a'] },
      { kind: 'hidden', selectors: ['#m'] },
    ])
  })

  it('takes the widths it is given, and an attribute without a value', () => {
    const options = parseArguments([...base, '--at', '375', '--at', '1280', '--attr', '#m', 'hidden'])
    expect(options.widths).toEqual([375, 1280])
    expect(options.assertions).toEqual([{ kind: 'attr', selectors: ['#m'], name: 'hidden', value: undefined }])
  })

  it.each([
    [['--page', '/a', '--no-hscroll'], '--serve is required'],
    [['--serve', 'x', '--no-hscroll'], 'at least one --page is required'],
    [base, 'at least one assertion is required'],
    [[...base, '--no-hscroll', '--at', '37.5'], '--at needs whole pixels'],
    [[...base, '--no-hscroll', '--at', '0'], '--at needs a positive number'],
    [[...base, '--no-overlap', '#a'], '--no-overlap needs 2 values'],
    [[...base, '--inside'], '--inside needs 1 value'],
    [[...base, '--wide'], 'unknown argument --wide'],
  ])('refuses %j: %s', (argv, message) => {
    expect(() => parseArguments(argv)).toThrow(UsageError)
    expect(() => parseArguments(argv)).toThrow(message)
  })
})
