import { describe, expect, it } from 'vitest'
import { commandFromHelp, usageCommands } from '../../scripts/contract/help.js'
import { HEAD_CLI } from '../../scripts/contract/json-samples.js'
import { commandsFromHelp, headCommands } from '../../scripts/contract/surface.js'

const ROOT_HELP = `mikoshi-construct — bootstrap (construct v0.17.2)

USAGE construct init|attach|jack-in|soulkill|inspect

COMMANDS

      init    Materialize the construct
`

const INIT_HELP = `Materialize the construct (construct init v0.17.2)

USAGE construct init [OPTIONS] 

OPTIONS

                   --dir=<dir>    Target directory (Default: .)
                       --plain    No colors, no lore (CI-friendly) (Default: false)
  --reviewModel=<review_model>    Model for the review workflow
                     -y, --yes    Non-interactive (Default: false)
                  --no-verbose    Quiet
                     --verbose    Chatty (Default: true)
`

describe('the command surface read from --help', () => {
  it('lists every command and alias named in the root USAGE line', () => {
    expect(usageCommands(ROOT_HELP)).toEqual(['init', 'attach', 'jack-in', 'soulkill', 'inspect'])
  })

  it('reads flags, their value hints and their short aliases, dropping the negated variant of a boolean', () => {
    expect(commandFromHelp('init', INIT_HELP)).toEqual({
      flags: {
        dir: { type: 'string' },
        plain: { type: 'boolean' },
        reviewModel: { type: 'string' },
        yes: { type: 'boolean', alias: 'y' },
        verbose: { type: 'boolean' },
      },
    })
  })

  it('reads a name whose header names another command as an alias of it', () => {
    expect(commandFromHelp('inspect', 'Extract the facts (alias: inspect, capture) (construct soulkill v0.17.2)\n')).toEqual({ aliasOf: 'soulkill' })
  })

  it('refuses a command with positional arguments rather than guess their names', () => {
    expect(() => commandFromHelp('graph', 'Draw (construct graph v1)\n\nUSAGE construct graph <OUT>\n\nARGUMENTS\n\n  OUT    Where\n')).toThrow('positional arguments')
  })

  it('refuses an option line it cannot read as a flag', () => {
    expect(() => commandFromHelp('init', 'Init (construct init v1)\n\nOPTIONS\n\n  dir    Target\n')).toThrow('not a flag: dir    Target')
  })

  it('reads HEAD\'s own --help as the commands HEAD\'s program declares', () => {
    expect(commandsFromHelp(HEAD_CLI)).toEqual(headCommands())
  }, 120_000)
})
