import type { RequestContext, RequestExecutor } from './context.js'
import type { MergeFacts, PatchedFile } from './reach.js'
import { Buffer } from 'node:buffer'
import { activeWindowShards, cardIdOf, decisionsInForceAt, isOwnerWaitNeed, MAIN_BRANCH, mergePolicy, Meter, openOwnerWait, OWNER_MERGES, OWNER_WAIT_NEEDS, prOf, QUEUE_ACTOR } from './reach.js'
import { text } from './request.js'

const REPO = 'repos/{owner}/{repo}'
const PULL_FILES_PAGE = 100

function patchedFilesOfPull(meter: Meter, pr: number): PatchedFile[] {
  const files: PatchedFile[] = []
  for (let page = 1; ; page += 1) {
    const listed = meter.get(`${REPO}/pulls/${pr}/files?per_page=${PULL_FILES_PAGE}&page=${page}`) as PatchedFile[]
    files.push(...listed)
    if (listed.length < PULL_FILES_PAGE)
      return files
  }
}

function mergeFactsUnder(context: RequestContext, windowShard: string, cardId: number, pr: number): MergeFacts {
  const meter = new Meter(context.gitHub, () => context.clock().getTime())
  const pull = meter.get(`${REPO}/pulls/${pr}`) as { title?: string, body?: string | null, head?: { ref?: string } }
  const ownerMerges = meter.get(`${REPO}/contents/${OWNER_MERGES}?ref=${MAIN_BRANCH}`) as { content?: string }
  if (typeof ownerMerges.content !== 'string')
    throw new Error(`${OWNER_MERGES} on ${MAIN_BRANCH} came back with no content`)
  const patched = patchedFilesOfPull(meter, pr)
  return {
    cardId,
    description: pull.body ?? '',
    headRef: pull.head?.ref ?? '',
    title: pull.title ?? '',
    files: patched.map(file => file.filename),
    patched,
    ownerMergesText: Buffer.from(ownerMerges.content, 'base64').toString('utf8'),
    shardActive: false,
    shardUnder: null,
    windowShard,
    decisions: decisionsInForceAt(context.db, context.clock()),
  }
}

function mergeLeftToTheBus(context: RequestContext, pr: number | null, card: number | null): string | null {
  const shard = activeWindowShards(context.db, context.clock())[0]
  const cardId = pr === null ? null : context.observed(pr)?.card_id ?? card
  if (shard === undefined || pr === null || cardId === null)
    return null
  try {
    const verdict = mergePolicy(mergeFactsUnder(context, shard.id, cardId, pr))
    return verdict.kind === 'allowed' ? `the merge policy under the live shard ${shard.id} leaves PR #${pr} to the bus (${verdict.detail}); no owner wait opens` : null
  }
  catch {
    return null
  }
}

export const execute: RequestExecutor = (context, request, payload) => {
  const need = payload.need
  const waitText = text(payload.text)
  const command = text(payload.command)
  if (!isOwnerWaitNeed(need))
    return { done: false, why: `owner.wait names need ${JSON.stringify(need ?? null)}, not one of ${OWNER_WAIT_NEEDS.join(', ')}` }
  if (waitText === null)
    return { done: false, why: 'owner.wait names no text of what the owner decides' }
  if (need === 'command' && command === null)
    return { done: false, why: 'owner.wait --need command names no command' }
  const card = cardIdOf(payload.card)
  const pr = prOf(payload.pr)
  const leftToTheBus = need === 'merge' ? mergeLeftToTheBus(context, pr, card) : null
  if (leftToTheBus !== null)
    return { done: false, why: leftToTheBus }
  const id = openOwnerWait(context.db, context.now(), QUEUE_ACTOR, { need, text: waitText, request, ...(command === null ? {} : { command }), ...(card === null ? {} : { card }), ...(pr === null ? {} : { pr }) })
  return { done: true, why: `opened ${id}` }
}
