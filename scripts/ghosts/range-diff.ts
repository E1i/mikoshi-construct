export type RangeDiffVerdict
  = | { ok: true }
    | { ok: false, reason: string }

export type GitRunner = (args: string[]) => string

const PAIR_LINE = /^ {0,3}(?:\d+|-):\s+(?:[0-9a-f]+|-+)\s+([=!<>])\s+(?:\d+|-):/

export function pairMarkers(rangeDiffOutput: string): string[] {
  return rangeDiffOutput.split('\n').flatMap((line) => {
    const marker = PAIR_LINE.exec(line)?.[1]
    return marker === undefined ? [] : [marker]
  })
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n').find(line => line.trim() !== '')?.trim() ?? 'no message'
}

export function rangeDiffVerdict(git: GitRunner, approved: string, launched: string, originMain: string): RangeDiffVerdict {
  const unable = (why: string): RangeDiffVerdict => ({ ok: false, reason: `git range-diff cannot compare the approved sketch ${approved.slice(0, 7)} with ${launched.slice(0, 7)} (${why}); re-approve the brief` })
  try {
    git(['cat-file', '-e', `${approved}^{commit}`])
  }
  catch {
    return unable(`${approved.slice(0, 7)} is not in the repository`)
  }
  try {
    const approvedBase = git(['merge-base', approved, originMain])
    const commits = Number(git(['rev-list', '--count', `${originMain}..${launched}`]))
    const markers = pairMarkers(git(['range-diff', '--no-color', '--no-patch', `${approvedBase}..${approved}`, `${originMain}..${launched}`]))
    const unchanged = markers.filter(marker => marker === '=').length
    if (commits > 0 && markers.length === commits && unchanged === commits)
      return { ok: true }
    return { ok: false, reason: `the sketch ${launched.slice(0, 7)} is not the approved ${approved.slice(0, 7)} rebased: git range-diff shows ${unchanged} of ${Math.max(commits, markers.length)} commits as '='; re-approve the brief` }
  }
  catch (error) {
    return unable(firstLine(error))
  }
}
