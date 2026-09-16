import { createApp } from './app.js'
import { readConfig } from './config.js'

const config = readConfig()
const app = createApp(config)

app.listen(config.port, () => {
  console.log(`${config.serviceName} listening on http://localhost:${config.port}`)
})
