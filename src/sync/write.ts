import type { Strategy } from '../materialize/strategies.js'
import type { TemplateVariant } from '../materialize/templates.js'
import type { PathClass, PathClassification, WriteEffect } from './classify.js'
import { substituteBlock } from '../materialize/strategies.js'
import { isWritable } from './classify.js'
import { ownedSha } from './ownership.js'

export const PENDING_CLASSES: PathClass[] = ['add', 'update', 'template-moved-on']

export interface PlannedWrite {
  target: string
  strategy: Strategy
  content: string
  ownedSha: string
  variant: TemplateVariant | null
  writeEffect: WriteEffect | null
}

export interface WritePlan {
  writes: PlannedWrite[]
  refused: PathClassification[]
}

export interface WriteInput {
  classifications: PathClassification[]
  present: Record<string, string>
  produced: Record<string, string>
}

export function isPending(classification: PathClassification): boolean {
  return PENDING_CLASSES.includes(classification.class)
}

function contentToWrite(classification: PathClassification, input: WriteInput): string {
  const produced = input.produced[classification.target] ?? ''
  const present = input.present[classification.target]
  if (classification.strategy !== 'append-block' || present == null)
    return produced
  return substituteBlock(present, produced, classification.target)
}

function variantWritten(classification: PathClassification, input: WriteInput): TemplateVariant | null {
  if (classification.strategy !== 'append-block')
    return null
  return classification.variant?.variant ?? (input.present[classification.target] == null ? 'default' : null)
}

function plannedWrite(classification: PathClassification, input: WriteInput): PlannedWrite {
  const content = contentToWrite(classification, input)
  return {
    target: classification.target,
    strategy: classification.strategy,
    content,
    ownedSha: ownedSha(classification.target, content),
    variant: variantWritten(classification, input),
    writeEffect: classification.writeEffect,
  }
}

export function planWrites(input: WriteInput): WritePlan {
  const writes: PlannedWrite[] = []
  const refused: PathClassification[] = []
  for (const classification of input.classifications) {
    if (isWritable(classification))
      writes.push(plannedWrite(classification, input))
    else if (isPending(classification))
      refused.push(classification)
  }
  return { writes, refused }
}
