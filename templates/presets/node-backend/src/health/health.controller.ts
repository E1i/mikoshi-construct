import type { Router } from 'express'
import type { HealthService } from './health.service.js'
import { asyncHandler } from '../http/async-handler.middleware.js'

export class HealthController {
  static register(router: Router, health: HealthService): void {
    router.get('/health', asyncHandler(async (_req, res) => {
      const snapshot = await health.snapshot()
      res.status(snapshot.status === 'ok' ? 200 : 503).json(snapshot)
    }))
  }
}
