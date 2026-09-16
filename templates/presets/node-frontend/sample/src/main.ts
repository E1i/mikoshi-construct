import { createApp } from './app.js'
import './styles/tokens.css'
import './styles/app.css'

const root = document.querySelector<HTMLElement>('#app')
if (root == null)
  throw new Error('index.html must contain <div id="app">')

createApp(root)
