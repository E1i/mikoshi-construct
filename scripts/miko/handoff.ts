import { execFileSync } from 'node:child_process'

const FOREMAN_PROMPT = 'Прочитай ~/.construct/handoff/foreman.md и продолжай как прораб'
const FOREMAN_SESSION = `cd ~/projects/mikoshi-construct && GH_TOKEN=$(gh auth token --user E1i) caffeinate -dis claude --permission-mode auto \\"${FOREMAN_PROMPT}\\"`
const NEW_TERMINAL_RUNNING_FOREMAN = `tell app "Terminal" to do script "${FOREMAN_SESSION}"`

execFileSync('osascript', ['-e', NEW_TERMINAL_RUNNING_FOREMAN], { stdio: 'inherit' })
