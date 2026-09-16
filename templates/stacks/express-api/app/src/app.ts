import type { AppConfig } from './config.js'
import type { HealthProbe } from './health/health.service.js'
import express from 'express'
import { HealthController } from './health/health.controller.js'
import { alwaysUp, HealthService } from './health/health.service.js'
import { createApiContractValidator } from './http/api-contract.middleware.js'
import { errorHandler } from './http/error-handler.middleware.js'

export interface AppDependencies {
  healthProbe?: HealthProbe
}

export function createApp(config: AppConfig, dependencies: AppDependencies = {}): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json())
  app.use(createApiContractValidator(config))

  const health = new HealthService(config.serviceName, dependencies.healthProbe ?? alwaysUp)

  const router = express.Router()
  HealthController.register(router, health)
  app.use(router)

  app.use(errorHandler)
  return app
}
