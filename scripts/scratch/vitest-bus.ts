import process from 'node:process'
import { BUS_DB_VARIABLE } from '../bus/db.js'
import { busWithCardStarted } from '../tests/ghosts/card-started-bus.js'

process.env[BUS_DB_VARIABLE] = busWithCardStarted([]).file
