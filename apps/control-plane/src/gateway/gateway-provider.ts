import type { GatewaySyncRequest, GatewaySyncResponse } from '@ai-gateway/contracts';

export interface GatewayProvider {
  publishRoute(input: GatewaySyncRequest): Promise<GatewaySyncResponse>;
  publishPolicyReference(input: GatewaySyncRequest): Promise<GatewaySyncResponse>;
  getSyncStatus(resourceId: string): Promise<GatewaySyncResponse | null>;
}
