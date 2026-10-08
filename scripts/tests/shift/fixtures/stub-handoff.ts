import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { HANDOFF_FIELDS } from '../../../ghosts/handoff-check.js'

const file = path.join(mkdtempSync(path.join(tmpdir(), 'stub-handoff-')), 'handoff.txt')
writeFileSync(file, `${HANDOFF_FIELDS.map(field => `${field.label}: ${field.label === 'queue' ? 'none' : 'x'}`).join('\n')}\n`)
process.env.STUB_HANDOFF = file
