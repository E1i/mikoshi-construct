import type { Reporter, TestModule, Vitest } from 'vitest/node'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { MIN_WEIGHT } from './shard.js'

export const FILE_WEIGHTS_NAME = 'file-weights.json'

export interface WholeFileTimings {
  readonly environmentSetupDuration: number
  readonly prepareDuration: number
  readonly setupDuration: number
  readonly collectDuration: number
  readonly duration: number
}

export interface MeasuredModule {
  readonly file: string
  readonly passed: boolean
  readonly timings: WholeFileTimings
}

export function wholeFileMilliseconds(timings: WholeFileTimings): number {
  return timings.environmentSetupDuration + timings.prepareDuration + timings.setupDuration + timings.collectDuration + timings.duration
}

const inSeconds = (milliseconds: number): number => Math.max(MIN_WEIGHT, Math.round(milliseconds / 100) / 10)

export function fileWeightsOf(modules: readonly MeasuredModule[]): Record<string, number> {
  return Object.fromEntries(modules
    .filter(measured => measured.passed)
    .map(measured => [measured.file, inSeconds(wholeFileMilliseconds(measured.timings))] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export function measuredModuleOf(testModule: TestModule, root: string): MeasuredModule {
  return {
    file: path.relative(root, testModule.moduleId).split(path.sep).join('/'),
    passed: testModule.state() === 'passed',
    timings: testModule.diagnostic(),
  }
}

export function jsonReportOf(config: Pick<Vitest['config'], 'outputFile'>): string | undefined {
  const { outputFile } = config
  return typeof outputFile === 'string' ? outputFile : outputFile?.json
}

export default class FileWeightsReporter implements Reporter {
  private root = ''
  private target = ''

  onInit(vitest: Vitest): void {
    const jsonReport = jsonReportOf(vitest.config)
    if (jsonReport === undefined)
      throw new Error(`the file-weights reporter writes ${FILE_WEIGHTS_NAME} beside the JSON report, and this run names no --outputFile for it`)
    this.root = vitest.config.root
    this.target = path.join(path.dirname(path.resolve(this.root, jsonReport)), FILE_WEIGHTS_NAME)
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const weights = fileWeightsOf(testModules.map(testModule => measuredModuleOf(testModule, this.root)))
    mkdirSync(path.dirname(this.target), { recursive: true })
    writeFileSync(this.target, `${JSON.stringify(weights, null, 2)}\n`)
  }
}
