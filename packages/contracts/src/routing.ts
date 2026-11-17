import type {AdmissionScope} from './index.js';
import type {PoolRouting} from './model-kinds.js';

export interface RoutingCandidate {
  id:string;
  serviceId:string;
  definitionId:string;
  serviceName:string;
  configVersion:number|null;
  weight:number;
  priority:number;
  rank:number|null;
  score:number|null;
  tie:number|null;
  status:'eligible'|'excluded'|'cooldown'|'capacity'|'quota_insufficient'|'selected'|'not_selected';
  reason:string|null;
  blockedScopes:string[];
  scopes:(AdmissionScope&{requests:number;tokens:number;active:number})[];
  latencyMs:number|null;
  latencySamples:number;
  cooldownUntil:string|null;
}

export interface RoutingDecision {
  strategy:PoolRouting['strategy'];
  candidateCount:number;
  sampledAt?:string;
  policyVersion?:string;
  candidateId?:string;
  selectedServiceId?:string|null;
  candidates?:RoutingCandidate[];
}

export interface RoutingSimulationInput {
  modelId:string;
  requestId?:string;
  estimatedInputTokens?:number;
  maxOutputTokens?:number;
  estimatedUnits?:number;
  routing?:PoolRouting;
  entries?:{serviceId:string;weight:number;priority:number}[];
}

export interface RoutingSimulation {
  poolId:string;
  modelId:string;
  requestId:string;
  decision:RoutingDecision;
  scope:'pool_and_services';
  notice:string;
}
