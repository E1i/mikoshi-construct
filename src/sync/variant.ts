import type { TemplateVariant } from '../materialize/templates.js'
import { sha256 } from '../manifest.js'
import { appendBlock } from '../materialize/strategies.js'
import { ownedSha } from './ownership.js'

export type VariantEvidence = 'recorded' | 'sole-variant' | 'reconstructed'

export interface EstablishedVariant {
  variant: TemplateVariant
  evidence: VariantEvidence
}

export interface VariantInput {
  target: string
  recordedVariant: TemplateVariant | null
  recordedSha: string | null
  present: string
  producedDefault: string
  existingTemplate: string | null
}

export function existingForm(target: string, template: string): string {
  return appendBlock('', template, target)
}

function shasOfDefaultForm(target: string, producedDefault: string): string[] {
  return [sha256(producedDefault), ownedSha(target, producedDefault)]
}

function shasOfExistingForm(target: string, template: string, present: string): string[] {
  return [sha256(appendBlock(present, template, target)), ownedSha(target, existingForm(target, template))]
}

export function establishVariant(input: VariantInput): EstablishedVariant | null {
  if (input.recordedVariant != null)
    return { variant: input.recordedVariant, evidence: 'recorded' }
  if (input.existingTemplate == null)
    return { variant: 'default', evidence: 'sole-variant' }
  if (input.recordedSha == null)
    return null

  const reconstructed: [TemplateVariant, string[]][] = [
    ['default', shasOfDefaultForm(input.target, input.producedDefault)],
    ['existing', shasOfExistingForm(input.target, input.existingTemplate, input.present)],
  ]
  const matched = reconstructed.filter(([, shas]) => shas.includes(input.recordedSha as string)).map(([variant]) => variant)
  return matched.length === 1 ? { variant: matched[0], evidence: 'reconstructed' } : null
}
