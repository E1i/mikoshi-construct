import type { Lore } from './lore.js'
import type { Theme } from './theme.js'
import process from 'node:process'
import { BANNER, LORE, PLAIN_LORE } from './lore.js'

export interface Ui {
  theme: Theme
  lore: Lore
  banner: (version: string, johnny: boolean) => void
  soulkiller: () => void
  phase: (index: number, total: number, icon: string, title: string) => void
  tree: (lines: Array<[string, string?]>) => void
  line: (text?: string) => void
  ok: (text: string) => void
  glitch: (text: string, details?: string[]) => void
  flatline: (text: string) => void
}

export function createUi(theme: Theme): Ui {
  const plain = theme.name === 'plain'
  const lore = plain ? PLAIN_LORE : LORE
  const out = (text = ''): void => {
    process.stdout.write(`${text}\n`)
  }
  const icon = (glyph: string, fallback: string): string => (plain ? fallback : glyph)

  return {
    theme,
    lore,
    banner(version, johnny) {
      if (plain) {
        out(lore.subtitle(version))
        out()
        return
      }
      if (johnny) {
        out()
        out(theme.accent(theme.bold(lore.johnnyWakeUp)))
        out(theme.dim(lore.subtitle(version)))
        out()
        return
      }
      out(theme.primary(BANNER))
      out(theme.accent(`  ${lore.subtitle(version)}`))
      out()
    },
    soulkiller() {
      out(`${icon('💀', '>>')} ${theme.accent(lore.soulkiller)}`)
    },
    phase(index, total, glyph, title) {
      out(`${theme.primary(`[${index}/${total}]`)} ${icon(glyph, '*')} ${theme.accent(theme.bold(title))}`)
    },
    tree(lines) {
      lines.forEach(([label, value], position) => {
        const branch = position === lines.length - 1 ? '└─' : '├─'
        const rendered = value == null ? label : `${label}: ${theme.detected(value)}`
        out(`  ${theme.dim(branch)} ${rendered}`)
      })
    },
    line: out,
    ok(text) {
      out(`${icon('✅', '[ok]')} ${theme.ok(theme.bold(text))}`)
    },
    glitch(text, details = []) {
      out(`${icon('⚠', '[warn]')} ${theme.warn(`${lore.glitch}:`)} ${text}`)
      for (const detail of details)
        out(`    ${theme.dim(detail)}`)
    },
    flatline(text) {
      out(`${icon('☠', '[error]')} ${theme.fail(`${lore.flatlined}:`)} ${text}`)
    },
  }
}
