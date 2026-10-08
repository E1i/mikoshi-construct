import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const HANDOFF = path.join(REPO_ROOT, 'scripts', 'miko', 'handoff.ts')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const RECORDING_OSASCRIPT = '#!/bin/sh\nfor arg in "$@"; do printf \'%s\\0\' "$arg"; done > "$OSASCRIPT_ARGS"\n'
const EXPECTED_SCRIPT = 'tell app "Terminal" to do script "cd ~/projects/mikoshi-construct && GH_TOKEN=$(gh auth token --user E1i) caffeinate -dis claude --permission-mode auto \\"Прочитай ~/.construct/handoff/mikoshi.md и продолжай как Mikoshi\\""'

describe('miko:handoff opens a new Terminal whose claude reads mikoshi.md', () => {
  it('hands osascript exactly the card\'s script and nothing else', () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'miko-handoff-'))
    const recorded = path.join(bin, 'args')
    writeFileSync(path.join(bin, 'osascript'), RECORDING_OSASCRIPT, { mode: 0o755 })
    try {
      execFileSync(TSX, [HANDOFF], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, OSASCRIPT_ARGS: recorded }, stdio: 'pipe' })
      expect(readFileSync(recorded, 'utf8').split('\0').slice(0, -1)).toEqual(['-e', EXPECTED_SCRIPT])
    }
    finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})
