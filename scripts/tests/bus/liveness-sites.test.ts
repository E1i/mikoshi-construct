import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { knownLivenessSites, LIVENESS_JUDGE, livenessSites, livenessSources, sortedLivenessSites, staleLivenessSites, unrecordedLivenessSites } from '../../bus/liveness-sites.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

function withExtra(file: string, text: string): Map<string, string> {
  const sources = livenessSources(REPO_ROOT)
  sources.set(file, `${sources.get(file) ?? ''}\n${text}\n`)
  return sources
}

describe('only the supervisor judges liveness, and every other ps, pid file and kill is recorded', () => {
  const found = livenessSites(livenessSources(REPO_ROOT))
  const known = knownLivenessSites(REPO_ROOT)

  it('ps, pid files and kill outside the supervisor are exactly the recorded baseline', () => {
    expect(unrecordedLivenessSites(found, known)).toEqual([])
    expect(staleLivenessSites(found, known)).toEqual([])
    expect(known).toEqual(sortedLivenessSites(known))
    expect(known.some(site => site.file === LIVENESS_JUDGE)).toBe(false)
  })

  it('a new ps, pid file or kill outside the supervisor fails, and the supervisor itself is no site', () => {
    const sneaked = livenessSites(withExtra('scripts/bus/merge-worker.ts', `const own = execFileSync('ps', ['-p', '1'])\nconst file = 'merge.pid'\nprocess.kill(1, 0)`))
    expect(unrecordedLivenessSites(sneaked, known)).toEqual([
      { file: 'scripts/bus/merge-worker.ts', kind: 'kill' },
      { file: 'scripts/bus/merge-worker.ts', kind: 'pid-file' },
      { file: 'scripts/bus/merge-worker.ts', kind: 'ps' },
    ])
    expect(unrecordedLivenessSites(livenessSites(withExtra(LIVENESS_JUDGE, `process.kill(1, 0)`)), known)).toEqual([])
  })

  it('a ps, pid file or kill spelled another way is still a site', () => {
    const spellings = [
      `const PS = 'ps'\nexecFileSync(PS, ['-ax'])`,
      `execSync('ps -axo pid=,args=')`,
      `spawnSync('sh', ['-c', 'pgrep -f bus'])`,
      `const { kill } = process\nkill(1, 'SIGTERM')`,
      `child.kill('SIGKILL')`,
      `execFileSync('kill', ['-9', '1'])`,
      `execSync('pkill -f bus')`,
      `const pidFile = path.join(dir, 'bus')`,
    ]
    for (const [index, spelling] of spellings.entries()) {
      const file = `scripts/bus/sneak-${index}.ts`
      expect(livenessSites(new Map([[file, spelling]])).map(site => site.file), spelling).toEqual([file])
    }
  })

  it('a recorded site that is gone fails, so the list only shrinks', () => {
    const gone = { file: 'scripts/bus/netwatch.ts', kind: 'ps' } as const
    expect(staleLivenessSites(found, [...known, gone])).toEqual([gone])
  })
})
