import type { GitRunner } from './sketch.js'
import { pairMarkers } from './sketch.js'

export type ReviewCarry
  = | { ok: true, ownCommits: number, merges: string[] }
    | { ok: false, reason: string }

function short(sha: string): string {
  return sha.slice(0, 7)
}

function lines(output: string): string[] {
  return output.split('\n').filter(line => line !== '')
}

function succeeds(git: GitRunner, args: string[]): boolean {
  try {
    git(args)
    return true
  }
  catch {
    return false
  }
}

function uncleanMerge(git: GitRunner, merge: string): string | undefined {
  const parents = lines(git(['rev-list', '--parents', '-n', '1', merge]))[0]?.split(' ').slice(1) ?? []
  if (parents.length !== 2)
    return `merge ${short(merge)} has ${parents.length} parents, not 2`
  let merged: string
  try {
    merged = lines(git(['merge-tree', '--write-tree', parents[0]!, parents[1]!]))[0] ?? ''
  }
  catch {
    return `merge ${short(merge)} resolved a conflict: git merge-tree of its parents does not merge cleanly`
  }
  const tree = git(['rev-parse', `${merge}^{tree}`])
  return merged === tree ? undefined : `merge ${short(merge)} holds tree ${short(tree)}, not the ${short(merged)} git merge-tree gives its parents`
}

export function reviewCarry(git: GitRunner, from: string, to: string, main: string): ReviewCarry {
  const refused = (why: string): ReviewCarry => ({ ok: false, reason: `the review of ${short(from)} does not carry to ${short(to)}: ${why}; review again` })
  if (!succeeds(git, ['merge-base', '--is-ancestor', from, to]))
    return refused(`${short(from)} is not an ancestor of ${short(to)}`)
  try {
    const fromBase = git(['merge-base', from, main])
    const toBase = git(['merge-base', to, main])
    const ownCommits = Number(git(['rev-list', '--count', '--no-merges', `${toBase}..${to}`]))
    const markers = pairMarkers(git(['range-diff', '--no-color', '--no-patch', `${fromBase}..${from}`, `${toBase}..${to}`]))
    if (!(ownCommits > 0 && markers.length === ownCommits && markers.every(marker => marker === '=')))
      return refused(`git range-diff of the pull request's own commits shows '${markers.join(' ')}' for ${ownCommits} commits, not every one '='`)
    const merges = lines(git(['rev-list', '--merges', '--first-parent', `${from}..${to}`]))
    const unclean = merges.map(merge => uncleanMerge(git, merge)).filter(reason => reason !== undefined)
    if (unclean.length > 0)
      return refused(unclean.join('; '))
    return { ok: true, ownCommits, merges }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return refused(message.split('\n').find(line => line.trim() !== '')?.trim() ?? 'git failed')
  }
}
