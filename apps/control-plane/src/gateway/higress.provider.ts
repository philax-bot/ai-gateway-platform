import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { GatewaySyncRequest, GatewaySyncResponse } from '@ai-gateway/contracts';
import type { GatewayProvider } from './gateway-provider';

@Injectable()
export class HigressProvider implements GatewayProvider {
  private readonly statuses = new Map<string, GatewaySyncResponse>();

  async publishRoute(input: GatewaySyncRequest): Promise<GatewaySyncResponse> {
    return this.publish(input);
  }

  async publishPolicyReference(input: GatewaySyncRequest): Promise<GatewaySyncResponse> {
    return this.publish(input);
  }

  async getSyncStatus(resourceId: string): Promise<GatewaySyncResponse | null> {
    return this.statuses.get(resourceId) ?? null;
  }

  private async publish(input: GatewaySyncRequest): Promise<GatewaySyncResponse> {
    const existing = this.statuses.get(input.resourceId);
    if (existing && existing.desiredVersion === input.desiredVersion) return existing;
    const response: GatewaySyncResponse = {
      provider: 'higress',
      resourceId: input.resourceId,
      desiredVersion: input.desiredVersion,
      appliedVersion: input.desiredVersion,
      status: 'applied',
      operationId: `provider-op-${randomUUID()}`,
      errorCode: null,
    };
    this.statuses.set(input.resourceId, response);
    return response;
  }
}
