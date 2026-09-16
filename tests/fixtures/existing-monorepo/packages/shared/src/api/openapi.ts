export interface paths {
  '/v1/health': {
    get: {
      responses: {
        200: { content: { 'application/json': { status: 'ok' } } }
      }
    }
  }
}
