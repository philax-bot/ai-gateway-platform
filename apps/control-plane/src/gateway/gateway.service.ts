import { Injectable } from '@nestjs/common';
import type { GatewaySyncRequest, GatewaySyncResponse } from '@ai-gateway/contracts';
import { HigressProvider } from './higress.provider';

@Injectable()
export class GatewayService {
  constructor(private readonly higressProvider: HigressProvider) {}

  publish(input: GatewaySyncRequest): Promise<GatewaySyncResponse> {
    if (input.resourceType === 'model_route') return this.higressProvider.publishRoute(input);
    return this.higressProvider.publishPolicyReference(input);
  }

  status(resourceId: string): Promise<GatewaySyncResponse | null> {
    return this.higressProvider.getSyncStatus(resourceId);
  }
}
