import { writeFileSync } from 'node:fs'
import path from 'node:path'

const [labCopy, object] = process.argv.slice(2)
if (object === 'substituted') {
  writeFileSync(path.join(labCopy, 'config.json'), '{"label":"substituted"}\n')
  console.log('config.json substituted')
}
else {
  console.log('config.json left as shipped')
}
