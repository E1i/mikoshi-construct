import type { ConvertedDigests } from '../scripts/harness-command/render.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { availablePresets, CONVERTED_TARGETS, convertedDigests, PNPM_HARNESS, PNPM_OUTPUT_FIXTURE, renderInit } from '../scripts/harness-command/render.js'

const NON_PNPM_HARNESS = 'make check'
const YAML_HOSTILE_HARNESS = 'make check: all # x'
const CI_WORKFLOW = '.github/workflows/ci.yml'
const MANIFEST = 'package.json'

interface WorkflowStep {
  name?: string
  run?: string
}

interface Workflow {
  jobs: Record<string, { steps: WorkflowStep[] }>
}

function withoutPackageScriptDefinitions(target: string, content: string): string {
  if (!target.endsWith(MANIFEST))
    return content
  const manifest = JSON.parse(content) as { scripts?: Record<string, string> }
  delete manifest.scripts?.ci
  return JSON.stringify(manifest)
}

function namingThePnpmHarness(rendered: Map<string, string>): string[] {
  return [...rendered]
    .filter(([target, content]) => withoutPackageScriptDefinitions(target, content).includes(PNPM_HARNESS))
    .map(([target]) => target)
}

function qualityRun(harnessCommand: string): string | undefined {
  const workflow = parse(renderInit('node-backend', harnessCommand).get(CI_WORKFLOW) ?? '') as Workflow
  return workflow.jobs.quality.steps.find(step => step.name === 'Quality')?.run
}

describe('the harness command in the rendered init output', () => {
  for (const presetId of availablePresets()) {
    it(`${presetId}: names no pnpm harness where the harness command is ${NON_PNPM_HARNESS}`, () => {
      const rendered = renderInit(presetId, NON_PNPM_HARNESS)
      for (const target of CONVERTED_TARGETS)
        expect(rendered.get(target), target).toContain(NON_PNPM_HARNESS)
      expect(namingThePnpmHarness(rendered)).toEqual([])
    })
  }

  it('renders the converted files byte for byte as they were before the harness command became a variable, under pnpm', () => {
    const recorded = JSON.parse(readFileSync(PNPM_OUTPUT_FIXTURE, 'utf8')) as ConvertedDigests
    const current = convertedDigests(PNPM_HARNESS)
    for (const presetId of availablePresets()) {
      for (const target of CONVERTED_TARGETS)
        expect(current[presetId]?.[target], `${presetId}: ${target} (regenerate with tsx scripts/harness-command/record.ts only for a deliberate template edit)`).toBe(recorded[presetId]?.[target])
    }
  })

  it('gives valid YAML whose quality step runs a command carrying ": " and " #" verbatim', () => {
    expect(qualityRun(YAML_HOSTILE_HARNESS)).toBe(YAML_HOSTILE_HARNESS)
  })

  it('keeps the pnpm harness a bare scalar in the workflow', () => {
    expect(renderInit('node-backend', PNPM_HARNESS).get(CI_WORKFLOW)).toContain(`run: ${PNPM_HARNESS}\n`)
    expect(qualityRun(PNPM_HARNESS)).toBe(PNPM_HARNESS)
  })
})
