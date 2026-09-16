import type { NextFunction, Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../src/http/app-error.js'
import { errorHandler } from '../../src/http/error-handler.middleware.js'

interface CapturedResponse {
  statusCode: number
  body: unknown
}

function handle(error: unknown): CapturedResponse {
  const captured: CapturedResponse = { statusCode: 0, body: undefined }
  const res = {
    headersSent: false,
    status(code: number) {
      captured.statusCode = code
      return this
    },
    json(payload: unknown) {
      captured.body = payload
    },
  }
  errorHandler(error, {} as Request, res as unknown as Response, (() => {}) as NextFunction)
  return captured
}

describe('errorHandler', () => {
  it('answers an AppError with its status, code and message only', () => {
    expect(handle(new AppError('THING_MISSING', 404, 'no such thing')))
      .toEqual({ statusCode: 404, body: { error: 'THING_MISSING', message: 'no such thing' } })
  })

  it('maps a contract validation failure to VALIDATION_ERROR with the offending paths', () => {
    const contractError = Object.assign(new Error('request failed'), {
      status: 400,
      errors: [{ path: '/body/name', message: 'must be string' }],
    })
    expect(handle(contractError))
      .toEqual({ statusCode: 400, body: { error: 'VALIDATION_ERROR', message: '/body/name must be string' } })
  })

  it('hides the cause of an unexpected error behind a generic 500 body', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = handle(new Error('connect ECONNREFUSED db:5432 password=hunter2'))
    log.mockRestore()
    expect(result).toEqual({ statusCode: 500, body: { error: 'INTERNAL_ERROR', message: 'Internal server error' } })
  })
})
