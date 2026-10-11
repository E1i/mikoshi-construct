import type { Preflight } from '../../ghosts/preflight.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { approvedHashPath, checkApproval } from '../../ghosts/approval.js'
import { approvalLine, checkAcceptanceBuild, hashBrief, PREFLIGHT_EVENT, rememberedPreflight, resolveApprover } from '../../ghosts/hash.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const HASH = path.join(REPO_ROOT, 'scripts/ghosts/hash.ts')
const MORSE_APPROVE = path.join(REPO_ROOT, 'scripts/ghosts/morse-approve.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const NOW = new Date(2026, 9, 4, 12)
const APPROVER = 'Approver One'
const HEAD_SHA = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

function GREEN_PREFLIGHT(): void {}
const SOUND_TEXT = '/implement Print the name.\nSketch: none — independent implementation is the witness\n\nAcceptance: the name is printed — witness: `echo name`'
const RED_ON_BASE_TEXT = '/implement Print the name.\nSketch: none — independent implementation is the witness\n\nAcceptance: the file is there — witness: `test -e added.txt`'
const BACKTICK_TEXT = '/implement Print the name.\nSketch: none — independent implementation is the witness\n\nAcceptance: the name is printed — witness: `echo `name``'

function worldDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ghosts-hash-'))
}

function briefWith(text: string): string {
  const brief = path.join(worldDir(), 'brief-t.md')
  writeFileSync(brief, `# head\n\nprose before the text\n\n---\n\n${text}\n`)
  return brief
}

function gitHome(userName: string | undefined): NodeJS.ProcessEnv {
  const home = worldDir()
  const gitconfig = path.join(home, '.gitconfig')
  writeFileSync(gitconfig, userName === undefined ? '' : `[user]\n\tname = ${userName}\n`)
  return { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' }
}

function cliRepository(): string {
  const root = worldDir()
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'repo')
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-C', cwd, ...args], { stdio: 'ignore' })
  }
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(path.join(repo, 'README.md'), 'base\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', 'origin', 'main')
  return repo
}

function runHash(args: string[], gitUserName?: string, cwd: string = worldDir()): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [TSX_CLI, ...args], { encoding: 'utf8', cwd, env: gitHome(gitUserName) })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('approvalLine', () => {
  it('gives no hash for a brief whose witness holds a backtick, and names the first build error', () => {
    const brief = briefWith(BACKTICK_TEXT)

    expect(() => approvalLine(brief, NOW, APPROVER)).toThrow(/check-acceptance build exited 2 .*no hash is printed: backtick: the name is printed/)
  })

  it('prints the whole approval line for a sound brief, which checkApproval accepts', () => {
    const brief = briefWith(SOUND_TEXT)
    const line = approvalLine(brief, NOW, APPROVER, checkAcceptanceBuild, GREEN_PREFLIGHT)

    expect(line).toBe(`approved /implement text sha256: ${hashBrief(brief)} sketch: none (2026-10-04, ${APPROVER})`)
    writeFileSync(approvedHashPath(brief), `${line}\n`)
    expect(checkApproval(brief)).toEqual({ ok: true, text: SOUND_TEXT, sha256: hashBrief(brief), approvedSketch: 'none' })
  })

  it('names only the first line the build printed on stderr', () => {
    const brief = briefWith(SOUND_TEXT)
    const runBuild = (): { status: number, stderr: string } => ({ status: 1, stderr: '\nfirst problem\nsecond problem\n' })

    expect(() => approvalLine(brief, NOW, APPROVER, runBuild)).toThrow(/: first problem$/)
  })

  it('names the whole sketch sha when the brief starts from one', () => {
    const brief = briefWith(SOUND_TEXT.replace(/^Sketch: .*$/m, `Sketch: sketch/t @ ${HEAD_SHA}`))

    expect(approvalLine(brief, NOW, APPROVER, checkAcceptanceBuild, GREEN_PREFLIGHT)).toBe(`approved /implement text sha256: ${hashBrief(brief)} sketch: ${HEAD_SHA} (2026-10-04, ${APPROVER})`)
  })
})

describe('rememberedPreflight', () => {
  const BASE_A = 'a'.repeat(40)
  const BASE_B = 'b'.repeat(40)

  function remembering(journalPath: string, base: () => string): { preflight: Preflight, runs: (string | undefined)[], logged: string[] } {
    const runs: (string | undefined)[] = []
    const logged: string[] = []
    const counted: Preflight = (input) => {
      runs.push(input.base)
    }
    const preflight = rememberedPreflight(counted, { journalPath, base, log: line => logged.push(line), now: () => NOW })
    return { preflight, runs, logged }
  }

  function inputOf(brief: string): Parameters<Preflight>[0] {
    return { briefPath: brief, text: readFileSync(brief, 'utf8'), sketch: { kind: 'none', reason: 'independent implementation is the witness' }, buildStdout: '' }
  }

  it('a repeat on the same text and base does not run the preflight', () => {
    const journalPath = path.join(worldDir(), 'handoff', 'ghosts.jsonl')
    const brief = briefWith(SOUND_TEXT)
    const { preflight, runs, logged } = remembering(journalPath, () => BASE_A)

    expect(approvalLine(brief, NOW, APPROVER, checkAcceptanceBuild, preflight)).toBe(approvalLine(brief, NOW, APPROVER, checkAcceptanceBuild, preflight))
    expect(runs).toEqual([BASE_A])
    expect(logged).toEqual([`preflight: base ${BASE_A.slice(0, 7)}; green on this text and base in ${journalPath}, not run again`])
    expect(readFileSync(journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as unknown)).toEqual([
      { event: PREFLIGHT_EVENT, sha256: hashBrief(brief), base: BASE_A, ok: true, ts: NOW.toISOString() },
    ])
  })

  it('a new text or a new base runs the preflight', () => {
    const journalPath = path.join(worldDir(), 'ghosts.jsonl')
    let base = BASE_A
    const { preflight, runs } = remembering(journalPath, () => base)
    const brief = briefWith(SOUND_TEXT)
    const changed = briefWith(SOUND_TEXT.replace('Print the name.', 'Print the whole name.'))

    preflight(inputOf(brief))
    preflight(inputOf(changed))
    base = BASE_B
    preflight(inputOf(brief))
    expect(runs).toEqual([BASE_A, BASE_A, BASE_B])
  })

  it('remembers no preflight that refused, so the next run tries again', () => {
    const journalPath = path.join(worldDir(), 'ghosts.jsonl')
    let refusals = 0
    const refusing = rememberedPreflight(() => {
      refusals += 1
      throw new Error('preflight P7: refused')
    }, { journalPath, base: () => BASE_A, log: () => {}, now: () => NOW })
    const input = inputOf(briefWith(SOUND_TEXT))

    expect(() => refusing(input)).toThrow('preflight P7: refused')
    expect(() => refusing(input)).toThrow('preflight P7: refused')
    expect(refusals).toBe(2)
    expect(existsSync(journalPath)).toBe(false)
  })
})

describe('resolveApprover', () => {
  it('takes --by over the git name, the git name without --by, and refuses when both are empty', () => {
    expect(resolveApprover('By Name', () => 'Git Name')).toBe('By Name')
    expect(resolveApprover(undefined, () => 'Git Name')).toBe('Git Name')
    expect(() => resolveApprover(undefined, () => '')).toThrow('approver not recorded: pass --by or set git config user.name')
  })
})

describe('hashBrief', () => {
  it('hashes from the /implement line to the end of the file, its last line included', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief.md')
    const text = '/implement Hash me.\n\nDesign:\n- the last line'
    writeFileSync(brief, `# head\n\nprose before the text\n\n---\n\n${text}`)

    const hash = hashBrief(brief)
    expect(hash).toBe(createHash('sha256').update(text).digest('hex'))
    expect(hash).not.toBe(createHash('sha256').update(text.slice(0, text.lastIndexOf('\n'))).digest('hex'))
  })

  it('refuses a brief with no /implement line, naming it', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief.md')
    writeFileSync(brief, '# no marker\n')

    expect(() => hashBrief(brief)).toThrow(brief)
  })
})

describe('ghosts:hash from the command line', () => {
  it('prints nothing on stdout and exits 1 for a brief the build refuses', () => {
    const result = runHash([HASH, briefWith(BACKTICK_TEXT), '--by', APPROVER])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('backtick: the name is printed')
  })

  it('prints the approval line when started through a symlink to the script', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief.md')
    writeFileSync(brief, `${SOUND_TEXT}\n`)
    const link = path.join(dir, 'hash.ts')
    symlinkSync(HASH, link)

    writeFileSync(brief, `${RED_ON_BASE_TEXT}\n`)
    const result = runHash([link, brief, '--by', APPROVER], 'Git Name', cliRepository())
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toMatch(new RegExp(`^approved /implement text sha256: ${hashBrief(brief)} sketch: none \\(\\d{4}-\\d{2}-\\d{2}, ${APPROVER}\\)$`))
  })

  it('signs with git config user.name when --by is not given', () => {
    const result = runHash([HASH, briefWith(RED_ON_BASE_TEXT)], 'Git Name', cliRepository())

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toMatch(/ sketch: none \(\d{4}-\d{2}-\d{2}, Git Name\)$/)
  })

  it('prints the preflight time and the pinned base on stderr beside the line on stdout', () => {
    const result = runHash([HASH, briefWith(RED_ON_BASE_TEXT), '--by', APPROVER], undefined, cliRepository())

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^approved \/implement text sha256: /)
    expect(result.stderr).toMatch(/preflight: base [0-9a-f]{7}; .*total \d+\.\ds/)
    expect(result.stderr).toContain('positive control: none (Sketch: none)')
  })

  it('prints no hash and exits 1 for a witness already green on the base, naming it', () => {
    const result = runHash([HASH, briefWith(SOUND_TEXT), '--by', APPROVER], undefined, cliRepository())

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/preflight P7: witness "the name is printed" exits 0 on the clean base [0-9a-f]{7}/)
  })

  it('refuses, printing no hash, when the current directory is in no git repository', () => {
    const result = runHash([HASH, briefWith(RED_ON_BASE_TEXT), '--by', APPROVER])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('preflight P0: run ghosts:hash inside the repository')
  })

  it('morse:approve writes only a morse approval and refuses an owner one', () => {
    const card = 903
    const brief = briefWith(RED_ON_BASE_TEXT.replace(/^(Sketch: .*)$/m, '$1\nexpect: tokens ≈ 166k, minutes ≈ 12 — effort medium, n=61, median, p25–p75 100k–200k'))
    const parking = worldDir()
    writeFileSync(path.join(parking, `${card}.md`), parkingFileText({ card: `#${card} task-${card} [implement/ghosts/S/cheap/owner] · depends — · blocks —`, branch: `feat/${card}`, touches: ['src/thing/**'], continue: 'stop', who: 'shift', body: 'Do the thing.' }))
    const handoff = worldDir()
    const morseApprove = (args: string[]): ReturnType<typeof runHash> => {
      const result = spawnSync(process.execPath, [TSX_CLI, MORSE_APPROVE, brief, String(card), '--parking', parking, ...args], { encoding: 'utf8', cwd: cliRepository(), env: { ...gitHome('Git Name'), CONSTRUCT_HANDOFF_DIR: handoff } })
      return { status: result.status, stdout: result.stdout, stderr: result.stderr }
    }

    for (const owner of [['--by', APPROVER], ['--by', 'morse']]) {
      const refused = morseApprove(owner)
      expect(refused.status).toBe(1)
      expect(refused.stdout).toBe('')
      expect(refused.stderr).toContain('usage: morse-approve.ts')
      expect(existsSync(approvedHashPath(brief))).toBe(false)
    }

    const approved = morseApprove([])
    expect(approved.stderr).not.toContain('usage')
    expect(approved.status).toBe(0)
    expect(approved.stdout.trim()).toMatch(new RegExp(`^approved /implement text sha256: ${hashBrief(brief)} sketch: none \\(\\d{4}-\\d{2}-\\d{2}, morse\\)$`))
    expect(readFileSync(approvedHashPath(brief), 'utf8')).toBe(approved.stdout)
    expect(readFileSync(path.join(handoff, 'ghosts.jsonl'), 'utf8')).toContain(`"by":"morse","card":${card}`)

    const ownerLine = `approved /implement text sha256: ${hashBrief(brief)} sketch: none (2026-10-09, ${APPROVER})\n`
    writeFileSync(approvedHashPath(brief), ownerLine)
    const overOwner = morseApprove([])
    expect(overOwner.status).toBe(1)
    expect(overOwner.stderr).toContain(`approved by ${APPROVER}; it is left as it is`)
    expect(readFileSync(approvedHashPath(brief), 'utf8')).toBe(ownerLine)
  })

  it('refuses, printing no hash, when neither --by nor git config user.name names the approver', () => {
    const result = runHash([HASH, briefWith(SOUND_TEXT)])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.trim()).toBe('approver not recorded: pass --by or set git config user.name')
  })
})
