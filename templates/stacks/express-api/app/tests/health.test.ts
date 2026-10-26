import type { HealthResponse } from '../src/health/health.service.js'
import inject from 'light-my-request'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config.js'

const config = readConfig({ NODE_ENV: 'test' })

describe('health endpoint', () => {
  it('answers ok with the contract shape', async () => {
    const response = await inject(createApp(config), { method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok', service: config.serviceName, time: expect.any(String) })
    expect(response.headers['x-powered-by']).toBeUndefined()
  })

  it('answers 503 when the probe fails', async () => {
    const app = createApp(config, { healthProbe: { ping: async () => false } })
    const response = await inject(app, { method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(503)
    expect(response.json<HealthResponse>().status).toBe('error')
  })

  it('answers 404 for a route outside the contract', async () => {
    const response = await inject(createApp(config), { method: 'GET', url: '/nowhere' })
    expect(response.statusCode).toBe(404)
  })
})
