import type { TemplateVars } from '../presets/index.js'
import type { Claim, Fact, RepositoryModel } from './schema.js'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { MODEL_FILE, MODEL_VERSION } from './schema.js'

export interface ModelInput {
  vars: TemplateVars
  contracts: boolean
}

const SECURITY_WORKFLOW = '.github/workflows/security.yml'
const CI_WORKFLOW = '.github/workflows/ci.yml'
const CONTRACT_WORKFLOW = '.github/workflows/api-contract.yml'

function baselineFacts(harnessCommand: string): Fact[] {
  return [
    { id: 'security-workflow', kind: 'file-exists', path: SECURITY_WORKFLOW },
    { id: 'security-workflow-runs-gitleaks', kind: 'file-contains', path: SECURITY_WORKFLOW, needle: 'gitleaks' },
    { id: 'gitleaks-config', kind: 'file-exists', path: '.gitleaks.toml' },
    { id: 'security-workflow-audits-dependencies', kind: 'file-contains', path: SECURITY_WORKFLOW, needle: 'pnpm audit --audit-level=high' },
    { id: 'ci-workflow', kind: 'file-exists', path: CI_WORKFLOW },
    { id: 'ci-workflow-runs-the-harness', kind: 'file-contains', path: CI_WORKFLOW, needle: harnessCommand },
    { id: 'eslint-config', kind: 'file-exists', path: 'eslint.config.mjs' },
    { id: 'security-invariants', kind: 'file-exists', path: 'architecture/security-invariants.md' },
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
    { id: 'contract-workflow', kind: 'file-exists', path: CONTRACT_WORKFLOW },
    { id: 'contract-workflow-fails-on-a-breaking-change', kind: 'file-contains', path: CONTRACT_WORKFLOW, needle: 'fail-on: ERR' },
    { id: 'api-contract', kind: 'file-exists', path: contractPath },
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

export function writeModel(root: string, model: RepositoryModel): void {
  writeFileSync(path.join(root, MODEL_FILE), `${JSON.stringify(model, null, 2)}\n`)
}
