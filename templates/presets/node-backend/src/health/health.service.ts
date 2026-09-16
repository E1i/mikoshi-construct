import type { components } from '../contracts/openapi.js'

export type HealthResponse = components['schemas']['HealthResponse']

export interface HealthProbe {
  ping: () => Promise<boolean>
}

export const alwaysUp: HealthProbe = {
  ping: async () => true,
}

export class HealthService {
  constructor(
    private readonly serviceName: string,
    private readonly probe: HealthProbe,
  ) {}

  async snapshot(): Promise<HealthResponse> {
    const up = await this.probe.ping()
    return { status: up ? 'ok' : 'error', service: this.serviceName, time: new Date().toISOString() }
  }
}
