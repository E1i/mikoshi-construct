import process from 'node:process'
import pc from 'picocolors'

export type ThemeName = 'arasaka' | 'johnny' | 'plain'

type Paint = (text: string) => string

export interface Theme {
  name: ThemeName
  primary: Paint
  accent: Paint
  detected: Paint
  dim: Paint
  ok: Paint
  warn: Paint
  fail: Paint
  bold: Paint
}

function rgb(r: number, g: number, b: number): Paint {
  return text => `[38;2;${r};${g};${b}m${text}[39m`
}

const identity: Paint = text => text

function supportsColor(): boolean {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== '')
    return false
  if (process.env.FORCE_COLOR != null && process.env.FORCE_COLOR !== '0')
    return true
  return pc.isColorSupported
}

function truecolor(): boolean {
  const term = process.env.COLORTERM ?? ''
  return term === 'truecolor' || term === '24bit'
}

const PLAIN: Theme = {
  name: 'plain',
  primary: identity,
  accent: identity,
  detected: identity,
  dim: identity,
  ok: identity,
  warn: identity,
  fail: identity,
  bold: identity,
}

function arasaka(): Theme {
  const tc = truecolor()
  return {
    name: 'arasaka',
    primary: tc ? rgb(230, 0, 46) : pc.red,
    accent: tc ? rgb(252, 238, 10) : pc.yellow,
    detected: tc ? rgb(0, 240, 255) : pc.cyan,
    dim: pc.dim,
    ok: tc ? rgb(0, 255, 159) : pc.green,
    warn: pc.yellow,
    fail: text => pc.bold(pc.red(text)),
    bold: pc.bold,
  }
}

function johnny(): Theme {
  const tc = truecolor()
  return {
    ...arasaka(),
    name: 'johnny',
    primary: tc ? rgb(255, 60, 0) : pc.red,
    accent: tc ? rgb(255, 176, 0) : pc.yellow,
    detected: tc ? rgb(255, 120, 60) : pc.magenta,
  }
}

export function resolveTheme(options: { plain?: boolean, johnny?: boolean }): Theme {
  if (options.plain === true || !supportsColor())
    return PLAIN
  return options.johnny === true ? johnny() : arasaka()
}
