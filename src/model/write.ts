import type { TemplateVars } from '../presets/index.js'
import type { Claim, EntryAuthor, Fact, Hypothesis, RepositoryModel } from './schema.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DanglingFactReference, MODEL_FILE, MODEL_VERSION, parseModel } from './schema.js'

export interface ModelInput {
  vars: TemplateVars
  contracts: boolean
}

const SECURITY_WORKFLOW = '.github/workflows/security.yml'
const CI_WORKFLOW = '.github/workflows/ci.yml'
const CONTRACT_WORKFLOW = '.github/workflows/api-contract.yml'

function baselineFacts(harnessCommand: string): Fact[] {
  return [
    { id: 'security-workflow', kind: 'file-exists', path: SECURITY_WORKFLOW, authoredBy: 'construct' },
    { id: 'security-workflow-runs-gitleaks', kind: 'file-contains', path: SECURITY_WORKFLOW, authoredBy: 'construct', needle: 'gitleaks' },
    { id: 'gitleaks-config', kind: 'file-exists', path: '.gitleaks.toml', authoredBy: 'construct' },
    { id: 'security-workflow-audits-dependencies', kind: 'file-contains', path: SECURITY_WORKFLOW, authoredBy: 'construct', needle: 'pnpm audit --audit-level=high' },
    { id: 'ci-workflow', kind: 'file-exists', path: CI_WORKFLOW, authoredBy: 'construct' },
    { id: 'ci-workflow-runs-the-harness', kind: 'file-contains', path: CI_WORKFLOW, authoredBy: 'construct', needle: harnessCommand },
    { id: 'eslint-config', kind: 'file-exists', path: 'eslint.config.mjs', authoredBy: 'construct' },
    { id: 'security-invariants', kind: 'file-exists', path: 'architecture/security-invariants.md', authoredBy: 'construct' },
  ]
}

function baselineClaims(harnessCommand: string): Claim[] {
  return [
    {
      id: 'no-committed-secret',
      statement: 'No secret, token or connection string is committed to this repository, including into gitignored files',
      authoredBy: 'construct',
      enforcement: {
        mechanism: `${SECURITY_WORKFLOW} runs gitleaks over the history on every push and pull request`,
        level: 'L3',
        supportedBy: ['security-workflow', 'security-workflow-runs-gitleaks'],
      },
      verification: {
        mechanism: '.gitleaks.toml keeps the default ruleset live for that scan',
        supportedBy: ['gitleaks-config'],
      },
    },
    {
      id: 'vulnerable-dependencies-are-visible',
      statement: 'Dependencies with known high-severity vulnerabilities are visible',
      authoredBy: 'construct',
      enforcement: {
        mechanism: 'security.yml runs pnpm audit weekly and on pull requests, reporting only',
        level: 'L3',
        supportedBy: ['security-workflow', 'security-workflow-audits-dependencies'],
      },
      verification: {
        mechanism: 'architecture/security-invariants.md names the mechanism behind each invariant',
        supportedBy: ['security-invariants'],
      },
    },
    {
      id: 'every-change-passes-the-harness',
      statement: 'Lint, typecheck and tests pass on every change, as one command',
      authoredBy: 'construct',
      enforcement: {
        mechanism: `${CI_WORKFLOW} runs ${harnessCommand} on every pull request and push to main`,
        level: 'L3',
        supportedBy: ['ci-workflow', 'ci-workflow-runs-the-harness'],
      },
      verification: {
        mechanism: 'eslint.config.mjs is the single source of style for that run',
        supportedBy: ['eslint-config'],
      },
    },
  ]
}

function contractFacts(contractPath: string): Fact[] {
  return [
    { id: 'contract-workflow', kind: 'file-exists', path: CONTRACT_WORKFLOW, authoredBy: 'construct' },
    { id: 'contract-workflow-fails-on-a-breaking-change', kind: 'file-contains', path: CONTRACT_WORKFLOW, authoredBy: 'construct', needle: 'fail-on: ERR' },
    { id: 'api-contract', kind: 'file-exists', path: contractPath, authoredBy: 'construct' },
  ]
}

function contractClaims(contractPath: string): Claim[] {
  return [
    {
      id: 'a-breaking-api-change-is-named-before-it-ships',
      statement: 'A change that breaks the HTTP API is identified on the pull request that makes it, never discovered afterwards',
      authoredBy: 'construct',
      enforcement: {
        mechanism: `${CONTRACT_WORKFLOW} runs oasdiff against the base branch and fails on a breaking change`,
        level: 'L3',
        supportedBy: ['contract-workflow', 'contract-workflow-fails-on-a-breaking-change'],
      },
      verification: {
        mechanism: `${contractPath} is the contract that comparison reads`,
        supportedBy: ['api-contract'],
      },
    },
  ]
}

export function buildModel(input: ModelInput): RepositoryModel {
  const { harnessCommand, contractPath } = input.vars
  return {
    modelVersion: MODEL_VERSION,
    facts: [...baselineFacts(harnessCommand), ...input.contracts ? contractFacts(contractPath) : []],
    claims: [...baselineClaims(harnessCommand), ...input.contracts ? contractClaims(contractPath) : []],
    hypotheses: [],
  }
}

export function readModel(root: string): RepositoryModel | null {
  const file = path.join(root, MODEL_FILE)
  if (!existsSync(file))
    return null
  try {
    return parseModel(readFileSync(file, 'utf8'), MODEL_FILE)
  }
  catch (error) {
    if (error instanceof DanglingFactReference)
      throw new Error(`${MODEL_FILE} stands on a fact that is not in it: ${error.entry} names "${error.factId}", which no fact declares. Nothing was written and ${MODEL_FILE} was not replaced: put the fact "${error.factId}" back, or drop it from ${error.entry}, and run this again.`)
    throw error
  }
}

interface Entry {
  id: string
  authoredBy: EntryAuthor
}

function mergeEntries<T extends Entry>(existing: T[], fresh: T[], keepDropped: (entry: T) => boolean): T[] {
  const rebuilt = new Map(fresh.map(entry => [entry.id, entry]))
  const survivors = existing.flatMap((entry) => {
    if (entry.authoredBy !== 'construct')
      return [entry]
    const replacement = rebuilt.get(entry.id)
    if (replacement !== undefined)
      return [replacement]
    return keepDropped(entry) ? [entry] : []
  })
  const present = new Set(survivors.map(entry => entry.id))
  return [...survivors, ...fresh.filter(entry => !present.has(entry.id))]
}

function factsStoodOn(claims: Claim[], hypotheses: Hypothesis[]): Map<string, string[]> {
  const stoodOn = new Map<string, string[]>()
  const record = (factId: string, entryId: string): void => {
    stoodOn.set(factId, [...stoodOn.get(factId) ?? [], entryId])
  }
  for (const claim of claims) {
    for (const factId of [...claim.enforcement?.supportedBy ?? [], ...claim.verification?.supportedBy ?? []])
      record(factId, claim.id)
  }
  for (const hypothesis of hypotheses) {
    for (const factId of hypothesis.supportedBy)
      record(factId, hypothesis.id)
  }
  return stoodOn
}

export interface RetainedFact {
  id: string
  stoodOnBy: string[]
}

export interface MergedModel {
  model: RepositoryModel
  retained: RetainedFact[]
}

export function mergeModel(existing: RepositoryModel | null, fresh: RepositoryModel): MergedModel {
  if (existing == null)
    return { model: fresh, retained: [] }
  const claims = mergeEntries(existing.claims, fresh.claims, () => false)
  const hypotheses = mergeEntries(existing.hypotheses, fresh.hypotheses, () => false)
  const stoodOn = factsStoodOn(claims, hypotheses)
  const rebuilt = new Set(fresh.facts.map(fact => fact.id))
  const retained = existing.facts
    .filter(fact => fact.authoredBy === 'construct' && !rebuilt.has(fact.id) && stoodOn.has(fact.id))
    .map(fact => ({ id: fact.id, stoodOnBy: stoodOn.get(fact.id) ?? [] }))
  return {
    model: {
      modelVersion: MODEL_VERSION,
      facts: mergeEntries(existing.facts, fresh.facts, fact => stoodOn.has(fact.id)),
      claims,
      hypotheses,
    },
    retained,
  }
}

export function writeModel(root: string, model: RepositoryModel): void {
  const source = `${JSON.stringify(model, null, 2)}\n`
  parseModel(source, MODEL_FILE)
  writeFileSync(path.join(root, MODEL_FILE), source)
}
