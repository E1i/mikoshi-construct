import type { TemplateVars } from '../presets/index.js'
import type { AuthoredEntry } from './ownership.js'
import type { Claim, Fact, Hypothesis, RepositoryModel } from './schema.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { authoredByOwner } from './ownership.js'
import { DanglingFactReference, MODEL_FILE, MODEL_VERSION, parseModel } from './schema.js'

export interface ModelInput {
  vars: TemplateVars
  contracts: boolean
  sample: boolean
}

const SECURITY_WORKFLOW = '.github/workflows/security.yml'
const CI_WORKFLOW = '.github/workflows/ci.yml'
const CONTRACT_WORKFLOW = '.github/workflows/api-contract.yml'
const MANIFEST = 'package.json'
const LINT_POLICY_TEST = 'scripts/tests/lint/syntax-policy.test.ts'

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
    { id: 'harness-manifest', kind: 'file-exists', path: MANIFEST, authoredBy: 'construct' },
    { id: 'harness-script-runs-lint', kind: 'file-contains', path: MANIFEST, authoredBy: 'construct', needle: 'pnpm lint' },
    { id: 'harness-script-runs-typecheck', kind: 'file-contains', path: MANIFEST, authoredBy: 'construct', needle: 'pnpm typecheck' },
    { id: 'harness-script-runs-tests', kind: 'file-contains', path: MANIFEST, authoredBy: 'construct', needle: 'pnpm test' },
  ]
}

function listed(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function harnessStepsClaim(harnessCommand: string, contracts: boolean): Claim {
  const steps = [...contracts ? ['contracts:check'] : [], 'lint', 'typecheck', 'tests']
  const spelled = [...contracts ? ['pnpm contracts:check'] : [], 'pnpm lint', 'pnpm typecheck', 'pnpm test']
  return {
    id: 'harness-steps',
    statement: `${harnessCommand} runs ${listed(steps)}, rather than merely existing as a script`,
    authoredBy: 'construct',
    enforcement: {
      mechanism: `${CI_WORKFLOW} runs ${harnessCommand} on every pull request, and ${MANIFEST} spells that command out as ${listed(spelled)}`,
      level: 'L3',
      supportedBy: [
        'ci-workflow-runs-the-harness',
        ...contracts ? ['harness-script-runs-contracts-check'] : [],
        'harness-script-runs-lint',
        'harness-script-runs-typecheck',
        'harness-script-runs-tests',
      ],
    },
    verification: {
      mechanism: `${MANIFEST} is the file that command resolves against, so a step dropped from it is visible there`,
      supportedBy: ['harness-manifest'],
    },
  }
}

function baselineClaims(harnessCommand: string, contracts: boolean): Claim[] {
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
        mechanism: 'security.yml runs pnpm audit weekly and on pull requests under continue-on-error, so it reports into the log and its check is green whether or not a vulnerability was found; nobody is obliged to read it',
        level: 'L0',
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
      checkId: 'ci',
    },
    harnessStepsClaim(harnessCommand, contracts),
  ]
}

function sampleFacts(): Fact[] {
  return [
    { id: 'lint-policy-test', kind: 'file-exists', path: LINT_POLICY_TEST, authoredBy: 'construct' },
    { id: 'lint-policy-test-loads-eslint', kind: 'file-contains', path: LINT_POLICY_TEST, authoredBy: 'construct', needle: 'import { ESLint } from \'eslint\'' },
  ]
}

function sampleClaims(harnessCommand: string): Claim[] {
  return [
    {
      id: 'lint-policy',
      statement: 'The lint policy this repository declares is itself checked by a test, not only applied by the linter',
      authoredBy: 'construct',
      enforcement: {
        mechanism: `${LINT_POLICY_TEST} asserts the restrictions the lint policy declares, and ${CI_WORKFLOW} runs ${harnessCommand} over it on every pull request`,
        level: 'L3',
        supportedBy: ['lint-policy-test', 'ci-workflow-runs-the-harness'],
      },
      verification: {
        mechanism: `${LINT_POLICY_TEST} resolves eslint.config.mjs through the ESLint API rather than reading its text`,
        supportedBy: ['lint-policy-test-loads-eslint', 'eslint-config'],
      },
      checkId: 'lint-policy',
    },
  ]
}

function contractFacts(contractPath: string): Fact[] {
  return [
    { id: 'contract-workflow', kind: 'file-exists', path: CONTRACT_WORKFLOW, authoredBy: 'construct' },
    { id: 'contract-workflow-fails-on-a-breaking-change', kind: 'file-contains', path: CONTRACT_WORKFLOW, authoredBy: 'construct', needle: 'fail-on: ERR' },
    { id: 'api-contract', kind: 'file-exists', path: contractPath, authoredBy: 'construct' },
    { id: 'harness-script-runs-contracts-check', kind: 'file-contains', path: MANIFEST, authoredBy: 'construct', needle: 'pnpm contracts:check' },
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
    facts: [...baselineFacts(harnessCommand), ...input.contracts ? contractFacts(contractPath) : [], ...input.sample ? sampleFacts() : []],
    claims: [...baselineClaims(harnessCommand, input.contracts), ...input.contracts ? contractClaims(contractPath) : [], ...input.sample ? sampleClaims(harnessCommand) : []],
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

function mergeEntries<T extends AuthoredEntry>(existing: T[], fresh: T[], keepDropped: (entry: T) => boolean): T[] {
  const rebuilt = new Map(fresh.map(entry => [entry.id, entry]))
  const survivors = existing.flatMap((entry) => {
    if (authoredByOwner(entry) !== 'construct')
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
    .filter(fact => authoredByOwner(fact) === 'construct' && !rebuilt.has(fact.id) && stoodOn.has(fact.id))
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
