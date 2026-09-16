import type { RequestHandler } from 'express'
import type { AppConfig } from '../config.js'
import { middleware as openApiValidator } from 'express-openapi-validator'

export function createApiContractValidator(config: AppConfig): RequestHandler[] {
  return openApiValidator({
    apiSpec: config.apiContractPath,
    validateRequests: { allowUnknownQueryParameters: true },
    validateResponses: config.validateApiResponses,
    validateSecurity: false,
    ignoreUndocumented: true,
  })
}
