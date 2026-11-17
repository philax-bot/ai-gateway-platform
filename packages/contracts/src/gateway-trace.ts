import type { Purpose,RequestIdentity } from './index.js';
export const gatewayStages=['accepted','authenticated','admitted','dispatched','upstream_response','first_output','generation_finished','settled','completed','interrupted'] as const;
export type GatewayStage=typeof gatewayStages[number];
export interface RouteAudit {serviceName:string;poolName:string;configVersion:number;endpoint:string}
export interface GatewayRequestTrace {
  attemptId:string;requestId:string;traceId:string;spanId:string;parentSpanId:string|null;revision:number;
  startedAt:string;updatedAt:string;completedAt:string|null;method:string;path:string;status:number|null;
  identity:RequestIdentity|null;purpose:Purpose|null;modelId:string|null;
  route:({serviceId:string;poolId:string;upstreamModel:string;audit?:RouteAudit})|null;
  upstreamRequestId:string|null;errorCode:string|null;replayed:boolean;
  stages:{stage:GatewayStage;at:string}[];
}
export interface GatewayTraceQuery {
  requestId?:string;traceId?:string;subjectId?:string;serviceId?:string;poolId?:string;
  from?:string;to?:string;state?:'active'|'ended'|'failed';cursor?:{at:string;id:string};limit?:number;
}
export interface GatewayTracePage {items:GatewayRequestTrace[];nextCursor:GatewayTraceQuery['cursor']|null;collectedAt:string}
