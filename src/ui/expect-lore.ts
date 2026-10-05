export interface ExpectLore {
  expectLine: (head: string, parts: string[]) => string
  expectNoneHead: (reason: string) => string
  expectForecastHead: (tokens: string, minutes: string, effort: string, n: number, band: string) => string
  expectBand: (p25: string, p75: string) => string
  expectNoneCount: (n: number, label: string) => string
  expectMixed: (label: string, efforts: string) => string
  expectSelection: (taskClass: string | null, effort: string | null) => string
  expectLedgerSource: (names: string) => string
  expectRunsNotRecorded: (sources: string) => string
  expectRejected: (count: number, source: string, reasons: string) => string
  expectRejectedReason: (times: number, reason: string) => string
  expectStepForecast: (step: string, subsample: string | null, tokens: string, minutes: string, band: string, n: number) => string
  expectStepNone: (step: string, reason: string) => string
  expectStepNoneReason: (n: number, effort: string, step: string, subsample: string | null) => string
  expectStepLine: (text: string) => string
  expectRoleForecast: (role: string, tokens: string, band: string, n: number) => string
  expectRoleNone: (role: string, reason: string) => string
  expectRoleNoneReason: (n: number, role: string) => string
  expectContourForecast: (tokens: string, band: string, covers: string, notCovered: string) => string
  expectContourNone: (notCovered: string) => string
  expectNotCovered: (items: string) => string
  expectUncovered: (name: string, reason: string) => string
  expectStepCacheMalformed: (line: number) => string
  expectUnreadRun: (run: string, agents: string) => string
  expectUnreadAgent: (agent: string, reason: string) => string
  costEffortNeedsExpect: string
  costEffortUnknown: (value: string) => string
}

export const EXPECT_LORE: ExpectLore = {
  expectLine: (head, parts) => `expect: ${[head, ...parts].join('; ')}`,
  expectNoneHead: reason => `none — ${reason}`,
  expectForecastHead: (tokens, minutes, effort, n, band) => `tokens ≈ ${tokens}, minutes ≈ ${minutes} — effort ${effort}, n=${n}, median, ${band}`,
  expectBand: (p25, p75) => `p25–p75 ${p25}–${p75}`,
  expectNoneCount: (n, label) => `n=${n} for ${label}`,
  expectMixed: (label, efforts) => `the sample for ${label} mixes efforts ${efforts}; pass --effort`,
  expectSelection: (taskClass, effort) => {
    const parts = [...(taskClass === null ? [] : [`class ${taskClass}`]), ...(effort === null ? [] : [`effort ${effort}`])]
    return parts.length === 0 ? 'every effort' : parts.join(', ')
  },
  expectLedgerSource: names => `ledger ${names}`,
  expectRunsNotRecorded: sources => `runs not recorded in ${sources}`,
  expectRejected: (count, source, reasons) => `${count} row${count === 1 ? '' : 's'} the ledger parser rejects not counted in ${source} (${reasons})`,
  expectRejectedReason: (times, reason) => `${times} ${reason}`,
  expectStepForecast: (step, subsample, tokens, minutes, band, n) => `${step}${subsample === null ? '' : ` (${subsample})`} tokens ≈ ${tokens}, minutes ≈ ${minutes}, ${band} — n=${n}`,
  expectStepNone: (step, reason) => `${step} none — ${reason}`,
  expectStepNoneReason: (n, effort, step, subsample) => `n=${n} for ${effort}/${step}${subsample === null ? '' : `, ${subsample}`}`,
  expectStepLine: text => `step ${text}`,
  expectRoleForecast: (role, tokens, band, n) => `${role} tokens ≈ ${tokens}, minutes not recorded, ${band} — n=${n}`,
  expectRoleNone: (role, reason) => `${role} none — ${reason}`,
  expectRoleNoneReason: (n, role) => `n=${n} for role ${role}`,
  expectContourForecast: (tokens, band, covers, notCovered) => `contour tokens ≈ ${tokens}, ${band} (sum of step bands) — covers ${covers}${notCovered}`,
  expectContourNone: notCovered => `contour none — no step has a sample${notCovered}`,
  expectNotCovered: items => `; not covered: ${items}`,
  expectUncovered: (name, reason) => `${name} (${reason})`,
  expectStepCacheMalformed: line => `step cache line ${line} is malformed; skipped`,
  expectUnreadRun: (run, agents) => `run ${run} is left out of the step forecast: ${agents}`,
  expectUnreadAgent: (agent, reason) => `agent ${agent} (${reason})`,
  costEffortNeedsExpect: '--effort needs --expect; nothing was written',
  costEffortUnknown: value => `--effort ${value} is not one of low, medium, high; nothing was written`,
}
