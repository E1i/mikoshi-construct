import type express from 'express'
import type { components } from '../contracts/openapi.js'
import { isAppError } from './app-error.js'

type ErrorResponse = components['schemas']['ErrorResponse']

interface ContractError extends Error {
  status: number
  errors: Array<{ path: string, message: string }>
}

function isContractError(error: unknown): error is ContractError {
  return error instanceof Error
    && typeof (error as ContractError).status === 'number'
    && Array.isArray((error as ContractError).errors)
}

function contractErrorPayload(error: ContractError): ErrorResponse {
  const message = error.errors.map(item => `${item.path} ${item.message}`).join('; ') || error.message
  if (error.status === 404)
    return { error: 'NOT_FOUND', message }
  if (error.status >= 500)
    return { error: 'INTERNAL_ERROR', message }
  return { error: 'VALIDATION_ERROR', message }
}

export function errorHandler(
  error: unknown,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
): void {
  if (res.headersSent)
    return

  if (isAppError(error)) {
    const payload: ErrorResponse = { error: error.code, message: error.message }
    res.status(error.status).json(payload)
    return
  }

  if (isContractError(error)) {
    res.status(error.status).json(contractErrorPayload(error))
    return
  }

  console.error('[Unhandled error]', error)
  const payload: ErrorResponse = { error: 'INTERNAL_ERROR', message: 'Internal server error' }
  res.status(500).json(payload)
}
