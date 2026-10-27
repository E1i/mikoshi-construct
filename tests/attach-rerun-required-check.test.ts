import type { Writer } from '../src/ui/console.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAttach } from '../src/commands/attach/index.js'
import { ATTACH_CARRIERS } from '../src/presets/index.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const NEXT_LABEL = 'Next: '
const RERUN_PREFIX = 'npx mikoshi-construct '
const ARGUMENTS_PRINTER = `printf '%s\\0' `

function collidingRepository(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-rerun-check-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  writeFileSync(path.join(root, 'main.go'), 'package main\n')
  for (const target of ATTACH_CARRIERS.targets) {
    mkdirSync(path.dirname(path.join(root, target)), { recursive: true })
    writeFileSync(path.join(root, target), 'the owner wrote this\n')
  }
  return root
}

function rerunWords(output: string, cwd: string): string[] {
  const line = output.split('\n').find(line => line.includes(NEXT_LABEL)) ?? ''
  const rerun = line.slice(line.indexOf(RERUN_PREFIX) + RERUN_PREFIX.length)
  return execFileSync('sh', ['-c', `${ARGUMENTS_PRINTER}${rerun}`], { cwd, encoding: 'utf8' }).split('\0').slice(0, -1)
}

describe('the collision refusal rerun line', () => {
  it.each(['gate', 'quality / it\'s $HOME'])('carries --required-check %s as one word after --harness', async (requiredCheck) => {
    const root = collidingRepository()
    let text = ''
    const write: Writer = (chunk) => {
      text += chunk
    }
    const result = await runAttach(createUi(resolveTheme({ plain: true }), write), { dir: root, harness: 'true', requiredCheck, yes: true })
    expect(result.refusal).toBe('collision')
    expect(rerunWords(text, root)).toEqual(['attach', '--dir', root, '--yes', '--harness', 'true', '--required-check', requiredCheck])
  })
})
