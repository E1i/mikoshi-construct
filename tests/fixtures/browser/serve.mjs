import { readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

const PAGES = path.join(import.meta.dirname, 'pages')
const DEFAULT_PAGE = 'fixed.html'
const [port] = process.argv.slice(2)

http.createServer(async (request, response) => {
  const name = path.basename(new URL(request.url, 'http://localhost').pathname)
  try {
    const body = await readFile(path.join(PAGES, name === '' ? DEFAULT_PAGE : name))
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(body)
  }
  catch {
    response.writeHead(404)
    response.end('not found')
  }
}).listen(Number(port), '127.0.0.1')
