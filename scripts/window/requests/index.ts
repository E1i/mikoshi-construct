import type { RequestContext, RequestExecutor } from './context.js'
import type { Executed, RequestKind, RequestPayload } from './request.js'
import { execute as allowMerge } from './allow-merge.js'
import { execute as amend } from './amend.js'
import { execute as ciRerun } from './ci-rerun.js'
import { execute as closePr } from './close-pr.js'
import { execute as decisionsAdd } from './decisions-add.js'
import { execute as drop } from './drop.js'
import { execute as hold } from './hold.js'
import { execute as mode } from './mode.js'
import { execute as numbersForeign } from './numbers-foreign.js'
import { execute as orderMove } from './order-move.js'
import { execute as ownerAnswer } from './owner-answer.js'
import { execute as ownerLaunch } from './owner-launch.js'
import { execute as ownerRequeue } from './owner-requeue.js'
import { execute as ownerStop } from './owner-stop.js'
import { execute as ownerTakeover } from './owner-takeover.js'
import { execute as ownerWaitClose } from './owner-wait-close.js'
import { execute as ownerWait } from './owner-wait.js'
import { execute as plan } from './plan.js'
import { execute as prBody } from './pr-body.js'
import { execute as release } from './release.js'
import { execute as reopenPr } from './reopen-pr.js'
import { execute as requeue } from './requeue.js'
import { execute as takeover } from './takeover.js'
import { execute as treeCut } from './tree-cut.js'

const KIND_SEPARATORS = /[.:]/g

export const REQUEST_EXECUTORS: Readonly<Record<RequestKind, RequestExecutor>> = {
  'tree.cut': treeCut,
  'amend': amend,
  'allow-merge': allowMerge,
  'close-pr': closePr,
  'reopen-pr': reopenPr,
  'pr.body': prBody,
  'ci.rerun': ciRerun,
  'requeue': requeue,
  'mode': mode,
  'plan': plan,
  'owner.wait': ownerWait,
  'owner.wait.close': ownerWaitClose,
  'decisions:add': decisionsAdd,
  'hold': hold,
  'release': release,
  'takeover': takeover,
  'drop': drop,
  'numbers.foreign': numbersForeign,
  'owner.answer': ownerAnswer,
  'order.move': orderMove,
  'owner.stop': ownerStop,
  'owner.launch': ownerLaunch,
  'owner.takeover': ownerTakeover,
  'owner.requeue': ownerRequeue,
}

export function requestFileOf(kind: RequestKind): string {
  return `${kind.replace(KIND_SEPARATORS, '-')}.ts`
}

export function dispatchRequest(context: RequestContext, kind: RequestKind, request: number, payload: RequestPayload): Executed {
  return REQUEST_EXECUTORS[kind](context, request, payload)
}
