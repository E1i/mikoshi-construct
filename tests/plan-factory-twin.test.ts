import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')
const FACTORY_COPY = '.claude/commands/plan.md'
const TEMPLATE_COPY = 'templates/ai/claude/_claude/commands/plan.md'
const FACTORY_BEGIN = '<!-- factory:begin -->'
const FACTORY_END = '<!-- factory:end -->'
const FACTORY_MARKER = /<!-- factory:(?:begin|end) -->/
const SKETCH_LINE = /^Sketch: <branch> @ <40-hex sha>$/

function read(copy: string): string {
  return readFileSync(path.join(ROOT, copy), 'utf8')
}

function withoutFactoryBlocks(text: string): string {
  const kept: string[] = []
  let insideBlock = false
  for (const line of text.split('\n')) {
    if (line === FACTORY_BEGIN) {
      if (insideBlock)
        throw new Error('a factory block opens inside another factory block')
      insideBlock = true
      continue
    }
    if (line === FACTORY_END) {
      if (!insideBlock)
        throw new Error('a factory block closes without opening')
      insideBlock = false
      continue
    }
    if (FACTORY_MARKER.test(line))
      throw new Error(`a factory marker shares its line with text: ${JSON.stringify(line)}`)
    if (!insideBlock)
      kept.push(line)
  }
  if (insideBlock)
    throw new Error('a factory block opens without closing')
  return kept.join('\n')
}

function withoutSketchLine(text: string): string {
  const lines = text.split('\n')
  const kept = lines.filter((line, index) => !(SKETCH_LINE.test(line) && lines[index - 1]?.startsWith('/implement ')))
  return kept.join('\n')
}

function templateOf(factoryText: string): string {
  return withoutSketchLine(withoutFactoryBlocks(factoryText))
}

describe('the factory /plan is the template plus what only the factory runs', () => {
  it('is byte-identical to the template once its factory blocks and its Sketch: line are cut', () => {
    expect(templateOf(read(FACTORY_COPY))).toBe(read(TEMPLATE_COPY))
  })

  it('leaves no factory marker in the template', () => {
    expect(read(TEMPLATE_COPY)).not.toMatch(FACTORY_MARKER)
  })

  it.each([
    ['a block that never closes', `a\n${FACTORY_BEGIN}\nb\n`],
    ['a block that never opens', `a\n${FACTORY_END}\nb\n`],
    ['a block inside a block', `${FACTORY_BEGIN}\n${FACTORY_BEGIN}\nb\n${FACTORY_END}\n${FACTORY_END}\n`],
    ['a marker sharing its line with text', `a ${FACTORY_BEGIN}\nb\n${FACTORY_END}\n`],
  ])('refuses %s', (_name, text) => {
    expect(() => withoutFactoryBlocks(text)).toThrow()
  })

  it('keeps a Sketch: line that does not follow /implement, so the twin goes red on it', () => {
    const text = 'intro\nSketch: <branch> @ <40-hex sha>\n'

    expect(templateOf(text)).toBe(text)
  })
})
