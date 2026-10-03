import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const CARRIER = path.join(ROOT, 'scripts/construct/browser-witness.mjs')
const SERVE = 'node tests/fixtures/browser/serve.mjs {port}'
const UNOBSERVED = 127

const CASES = [
  { name: 'a card wider than the viewport scrolls', args: ['--page', '/bleed.html', '--at', '375', '--no-hscroll'], code: 1, has: ['scrollWidth=412 > innerWidth=375 at /bleed.html @375'] },
  { name: 'a fluid page holds at 375', args: ['--page', '/fixed.html', '--at', '375', '--no-hscroll'], code: 0, has: ['ok'] },
  { name: 'the same wide card holds at 1280', args: ['--page', '/bleed.html', '--at', '1280', '--no-hscroll'], code: 0, has: ['scrollWidth=1280 <= innerWidth=1280'] },
  { name: 'each width is measured on its own', args: ['--page', '/bleed.html', '--at', '375', '--at', '1280', '--no-hscroll'], code: 1, has: ['FAIL no-hscroll: scrollWidth=412 > innerWidth=375', 'ok   no-hscroll: scrollWidth=1280'], lacks: ['FAIL no-hscroll: scrollWidth=1280'] },
  { name: 'a 100vw element inside padding scrolls at every width', args: ['--page', '/vw-bleed.html', '--at', '1280', '--no-hscroll'], code: 1, has: ['scrollWidth=1296 > innerWidth=1280'] },
  { name: 'a page exactly as wide as the viewport holds', args: ['--page', '/exact.html', '--at', '375', '--no-hscroll'], code: 0, has: ['scrollWidth=375 <= innerWidth=375'] },
  { name: 'a selector that matches nothing fails', args: ['--page', '/fixed.html', '--at', '375', '--visible', '.nope'], code: 1, has: ['.nope matches 0 elements'] },
  { name: 'overlapping boxes fail no-overlap', args: ['--page', '/overlap.html', '--at', '375', '--no-overlap', '#a', '#b'], code: 1, has: ['#a[0]', 'overlaps #b[0]'] },
  { name: 'boxes touching at an edge hold', args: ['--page', '/overlap.html', '--at', '375', '--no-overlap', '#c', '#d'], code: 0, has: ['do not overlap'] },
  { name: 'an element left of the viewport fails inside', args: ['--page', '/overlap.html', '--at', '375', '--inside', '#off'], code: 1, has: ['left=-50'] },
  { name: 'an element within the viewport holds inside', args: ['--page', '/overlap.html', '--at', '375', '--inside', '#a'], code: 0, has: ['ok'] },
  { name: 'an attribute with its value holds', args: ['--page', '/overlap.html', '--at', '375', '--attr', '#menu', 'aria-expanded=false'], code: 0, has: ['ok'] },
  { name: 'an attribute with another value fails', args: ['--page', '/overlap.html', '--at', '375', '--attr', '#menu', 'aria-expanded=true'], code: 1, has: ['aria-expanded="false"'] },
  { name: 'a visible element holds visible', args: ['--page', '/overlap.html', '--at', '375', '--visible', '#a'], code: 0, has: ['ok'] },
  { name: 'a hidden element holds hidden', args: ['--page', '/overlap.html', '--at', '375', '--hidden', '#menu', '--hidden', '#gone'], code: 0, has: ['ok'] },
  { name: 'a hidden element fails visible', args: ['--page', '/overlap.html', '--at', '375', '--visible', '#menu'], code: 1, has: ['not visible'] },
  { name: 'a page that is not served fails', args: ['--page', '/missing.html', '--at', '375', '--no-hscroll'], code: 1, has: ['HTTP 404'] },
  { name: 'a dead serve command could not observe', serve: 'exit 3', args: ['--page', '/fixed.html', '--no-hscroll'], code: UNOBSERVED, has: ['could not observe: the serve command exited (3)'], lacks: ['usage error:'] },
  { name: 'a serve command that never listens could not observe', serve: 'sleep 30', args: ['--page', '/fixed.html', '--no-hscroll', '--ready-timeout', '1'], code: UNOBSERVED, has: ['did not answer within 1s'] },
  { name: 'no npx could not observe', serve: `${process.execPath} tests/fixtures/browser/serve.mjs {port}`, env: { PATH: '/nonexistent' }, args: ['--page', '/fixed.html', '--no-hscroll'], code: UNOBSERVED, has: ['npx could not provide'] },
  { name: 'no serve command is a usage error, also unobserved', serve: null, args: ['--page', '/fixed.html', '--no-hscroll'], code: UNOBSERVED, has: ['usage error: --serve is required'], lacks: ['could not observe:'] },
  { name: 'an unwritable screenshot directory changes no exit code, holding', shots: '/dev/null/shots', args: ['--page', '/fixed.html', '--at', '375', '--no-hscroll'], code: 0, has: ['screenshots unavailable'] },
  { name: 'an unwritable screenshot directory changes no exit code, failing', shots: '/dev/null/shots', args: ['--page', '/bleed.html', '--at', '375', '--no-hscroll'], code: 1, has: ['screenshots unavailable'] },
]

function run(testCase, shots) {
  const serve = testCase.serve === undefined ? SERVE : testCase.serve
  const argv = [CARRIER, ...(serve === null ? [] : ['--serve', serve]), '--shots', testCase.shots ?? shots, ...testCase.args]
  const result = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...testCase.env } })
  return { code: result.status, text: `${result.stdout}${result.stderr}` }
}

function countRuns(shots) {
  return readdirSync(shots).length
}

const shots = mkdtempSync(path.join(tmpdir(), 'browser-witness-'))
const problems = []

for (const testCase of CASES) {
  const { code, text } = run(testCase, shots)
  const missing = (testCase.has ?? []).filter(part => !text.includes(part))
  const unwanted = (testCase.lacks ?? []).filter(part => text.includes(part))
  const wrong = code !== testCase.code || missing.length > 0 || unwanted.length > 0
  process.stdout.write(`${wrong ? 'FAIL' : 'ok  '} ${testCase.name}\n`)
  if (wrong)
    problems.push(`${testCase.name}: exit ${code}, expected ${testCase.code}; missing ${JSON.stringify(missing)}; unwanted ${JSON.stringify(unwanted)}\n${text}`)
}

const shotsDir = mkdtempSync(path.join(tmpdir(), 'browser-witness-runs-'))
for (let index = 0; index < 7; index += 1)
  run({ args: ['--page', '/fixed.html', '--at', '375', '--at', '1280', '--no-hscroll'] }, shotsDir)
const runs = countRuns(shotsDir)
const newest = path.join(shotsDir, readdirSync(shotsDir).sort().at(-1))
const kept = runs === 5 && existsSync(path.join(newest, '375.png')) && existsSync(path.join(newest, '1280.png'))
process.stdout.write(`${kept ? 'ok  ' : 'FAIL'} seven runs leave the five latest, each with a screenshot per viewport\n`)
if (!kept)
  problems.push(`runs kept: ${runs}; newest ${newest}`)

rmSync(shots, { recursive: true, force: true })
rmSync(shotsDir, { recursive: true, force: true })

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n\n')}\n`)
  process.exit(1)
}
