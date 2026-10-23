import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { heroHtml } from '../src/atlas/chrome.js'
import { repoIdentity } from '../src/atlas/identity.js'

function repository(files: Record<string, string>): string {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'atlas-identity-')), 'orchard-folder')
  mkdirSync(root)
  for (const [file, content] of Object.entries(files))
    writeFileSync(path.join(root, file), content)
  return root
}

const README = '<p align="center"><img src="logo.svg"></p>\n\n# Orchard Press\n\n[![ci](badge.svg)](ci)\n\nPresses apples\ninto juice.\n\nMore below.\n'

const CASES = {
  'package.json': {
    files: { 'package.json': JSON.stringify({ name: '@farm/orchard', description: 'Juice from the orchard' }), 'README.md': README },
    identity: { name: { text: '@farm/orchard', from: 'package.json' }, description: { text: 'Juice from the orchard', from: 'package.json' } },
    shown: ['name from package.json', 'description from package.json'],
  },
  'package.json without a description': {
    files: { 'package.json': JSON.stringify({ name: 'orchard' }), 'README.md': README },
    identity: { name: { text: 'orchard', from: 'package.json' }, description: { text: 'Presses apples into juice.', from: 'README' } },
    shown: ['name from package.json', 'description from the README'],
  },
  'README without package.json': {
    files: { 'README.md': README },
    identity: { name: { text: 'Orchard Press', from: 'README' }, description: { text: 'Presses apples into juice.', from: 'README' } },
    shown: ['name from the README heading', 'description from the README'],
  },
  'unreadable package.json and a lower-case readme': {
    files: { 'package.json': '{ not json', 'readme': '# Orchard\n' },
    identity: { name: { text: 'Orchard', from: 'README' } },
    shown: ['name from the README heading', 'no description found'],
  },
  'neither file': {
    files: {},
    identity: { name: { text: 'orchard-folder', from: 'folder' } },
    shown: ['name from the folder', 'no description found'],
  },
} as const

describe('the repository identity in the atlas header', () => {
  for (const [name, { files, identity, shown }] of Object.entries(CASES)) {
    it(`${name}: the name and description come from the first adapter that answers, and the header says which`, () => {
      const found = repoIdentity(repository(files))
      expect(found).toEqual(identity)
      const hero = heroHtml('map', found, null)
      expect(hero).toContain(`>${identity.name.text}</h1>`)
      for (const line of shown)
        expect(hero).toContain(`<span>${line}</span>`)
    })
  }

  it('a header with no description draws no lede', () => {
    expect(heroHtml('docs', { name: { text: 'unknown repo', from: 'none' } }, null)).not.toContain('class="lede"')
    expect(heroHtml('docs', { name: { text: 'unknown repo', from: 'none' } }, null)).toContain('<span>no name found</span>')
  })
})
