import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../../composition/files.js'

const SAMPLES = {
  plainModule: 'export function open(element: HTMLElement): void {\n  element.dataset.state = \'open\'\n}\n',
  classListCall: 'export function open(element: HTMLElement): void {\n  element.classList.add(\'is-open\')\n}\n',
  classListComputed: 'export function open(element: HTMLElement): void {\n  element.classList[\'add\'](\'is-open\')\n}\n',
  classListOnComputedElement: 'export function open(element: HTMLElement): void {\n  element[\'classList\'].add(\'is-open\')\n}\n',
  classListBound: 'export function open(element: HTMLElement): void {\n  const classes = element.classList\n  classes.add(\'is-open\')\n}\n',
  inlineStyleWrite: 'export function open(element: HTMLElement): void {\n  element.style.display = \'block\'\n}\n',
  inlineStyleWriteComputed: 'export function open(element: HTMLElement): void {\n  element[\'style\'].display = \'block\'\n}\n',
  inlineStyleProperty: 'export function open(element: HTMLElement): void {\n  element.style.setProperty(\'--open\', \'1\')\n}\n',
  inlineStylePropertyComputed: 'export function open(element: HTMLElement): void {\n  element.style[\'setProperty\'](\'--open\', \'1\')\n}\n',
  inlineStyleBound: 'export function open(element: HTMLElement): void {\n  const style = element.style\n  style.display = \'block\'\n}\n',
} as const

type SampleName = keyof typeof SAMPLES

const CLASS_LIST_FORMS: SampleName[] = ['classListCall', 'classListComputed', 'classListOnComputedElement', 'classListBound']
const INLINE_STYLE_FORMS: SampleName[] = ['inlineStyleWrite', 'inlineStyleWriteComputed', 'inlineStyleProperty', 'inlineStylePropertyComputed', 'inlineStyleBound']

const ROLES: Array<{ role: string, file: string, reported: SampleName[], exempt: SampleName[] }> = [
  {
    role: 'an application module',
    file: 'src/app.ts',
    reported: [...CLASS_LIST_FORMS, ...INLINE_STYLE_FORMS],
    exempt: [],
  },
  {
    role: 'the entry point',
    file: 'src/main.ts',
    reported: [...CLASS_LIST_FORMS, ...INLINE_STYLE_FORMS],
    exempt: [],
  },
  {
    role: 'a test',
    file: 'tests/app.test.ts',
    reported: [],
    exempt: [...CLASS_LIST_FORMS, ...INLINE_STYLE_FORMS],
  },
  {
    role: 'a repository script',
    file: 'scripts/composition/check.ts',
    reported: [],
    exempt: [...CLASS_LIST_FORMS, ...INLINE_STYLE_FORMS],
  },
]

const eslint = new ESLint({
  cwd: REPO_ROOT,
  ruleFilter: ({ ruleId }) => ruleId === 'no-restricted-syntax',
  overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
})

async function restrictionReports(file: string, sample: SampleName): Promise<string[]> {
  const [result] = await eslint.lintText(SAMPLES[sample], { filePath: file })
  const fatal = result.messages.find(message => message.fatal)
  if (fatal)
    throw new Error(`${file} (${sample}): ${fatal.message}`)
  return result.messages
    .filter(message => message.ruleId === 'no-restricted-syntax')
    .map(message => message.message)
}

describe('styling policy by file role', () => {
  for (const { role, file, reported, exempt } of ROLES) {
    it(`reports every restricted form in ${role}`, async () => {
      for (const sample of reported)
        expect(await restrictionReports(file, sample), sample).not.toEqual([])
    })

    it(`reports nothing ${role} may legitimately write`, async () => {
      for (const sample of ['plainModule' as SampleName, ...exempt])
        expect(await restrictionReports(file, sample), sample).toEqual([])
    })
  }
})
