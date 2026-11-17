import {BadRequestException} from '@nestjs/common';
import {gatewayStages,isRequestReference,type GatewayRequestTrace,type GatewayTraceQuery} from '@ai-gateway/contracts';
const fail=():never=>{throw new BadRequestException('invalid gateway trace');};
const reference=(v:unknown)=>v===null?null:isRequestReference(v)?v:fail();
const iso=(v:unknown)=>typeof v==='string'&&v.length<=30&&new Date(v).toISOString()===v?v:fail();
export function validateGatewayTrace(raw:GatewayRequestTrace):GatewayRequestTrace {
  try{
    if(!raw||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(raw.attemptId)||!/^[a-f0-9]{32}$/.test(raw.traceId)||/^0+$/.test(raw.traceId)||!/^[a-f0-9]{16}$/.test(raw.spanId)||/^0+$/.test(raw.spanId))fail();
    if(raw.parentSpanId!==null&&(!/^[a-f0-9]{16}$/.test(raw.parentSpanId)||/^0+$/.test(raw.parentSpanId)))fail();
    if(!Number.isSafeInteger(raw.revision)||raw.revision<1||raw.revision>32||!Array.isArray(raw.stages)||raw.stages.length<1||raw.stages.length>gatewayStages.length)fail();
    if(typeof raw.method!=='string'||!/^[A-Z]{1,20}$/.test(raw.method)||typeof raw.path!=='string'||!/^\/v1(?:\/[a-zA-Z0-9_/-]*)?$/.test(raw.path)||raw.path.length>160)fail();
    const stages=raw.stages.map(e=>{if(!gatewayStages.includes(e.stage))fail();return {stage:e.stage,at:iso(e.at)};});
    if(stages[0].stage!=='accepted'||new Set(stages.map(e=>e.stage)).size!==stages.length||stages.some((e,i)=>i&&e.at<stages[i-1].at))fail();
    const startedAt=iso(raw.startedAt),updatedAt=iso(raw.updatedAt),completedAt=raw.completedAt===null?null:iso(raw.completedAt);
    if(stages[0].at!==startedAt||stages.at(-1)!.at!==updatedAt||updatedAt<startedAt||completedAt!==null&&(completedAt!==updatedAt||!['completed','interrupted'].includes(stages.at(-1)!.stage)))fail();
    if(raw.status!==null&&(!Number.isInteger(raw.status)||raw.status<100||raw.status>599))fail();
    const identity=raw.identity===null?null:{subjectType:raw.identity.subjectType,subjectId:reference(raw.identity.subjectId)!,credentialId:reference(raw.identity.credentialId)!,...(raw.identity.organizationId?{organizationId:reference(raw.identity.organizationId)!}:{}),...(raw.identity.projectId?{projectId:reference(raw.identity.projectId)}:{})};
    if(identity&&(!identity.subjectId||!identity.credentialId||!['employee','application'].includes(identity.subjectType)))fail();
    if(raw.purpose!==null&&!['personal','project','application'].includes(raw.purpose))fail();
    let route:GatewayRequestTrace['route']=null;
    if(raw.route){if(!identity)fail();const a=raw.route.audit;
      if(a&&(!Number.isSafeInteger(a.configVersion)||a.configVersion<0||typeof a.endpoint!=='string'||a.endpoint.length>2048))fail();
      if(a){const u=new URL(a.endpoint);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)fail();}
      route={serviceId:reference(raw.route.serviceId)!,poolId:reference(raw.route.poolId)!,upstreamModel:reference(raw.route.upstreamModel)!,...(a?{audit:{serviceName:reference(a.serviceName)!,poolName:reference(a.poolName)!,configVersion:a.configVersion,endpoint:a.endpoint}}:{})};
      if(!route.serviceId||!route.poolId||!route.upstreamModel)fail();
    }
    if(raw.errorCode!==null&&(typeof raw.errorCode!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(raw.errorCode)))fail();
    const requestId=reference(raw.requestId);if(!requestId)fail();
    return {attemptId:raw.attemptId,requestId:requestId!,traceId:raw.traceId,spanId:raw.spanId,parentSpanId:raw.parentSpanId,revision:raw.revision,startedAt,updatedAt,completedAt,method:raw.method,path:raw.path,status:raw.status,identity,purpose:raw.purpose,modelId:reference(raw.modelId),route,upstreamRequestId:reference(raw.upstreamRequestId),errorCode:raw.errorCode,replayed:raw.replayed===true,stages};
  }catch{return fail();}
}
export function traceQuery(raw:GatewayTraceQuery={}){
  try{
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['requestId','traceId','subjectId','serviceId','poolId','from','to','state','cursor','limit'].includes(k)))fail();
    for(const key of ['requestId','traceId','subjectId','serviceId','poolId'] as const)if(raw[key]!==undefined&&!isRequestReference(raw[key]))fail();
    for(const key of ['from','to'] as const)if(raw[key]!==undefined)iso(raw[key]);
    if(raw.from&&raw.to&&raw.from>=raw.to)fail();
    if(raw.state!==undefined&&!['active','ended','failed'].includes(raw.state))fail();
    if(raw.cursor){iso(raw.cursor.at);if(!/^[a-f0-9-]{36}$/.test(raw.cursor.id))fail();}
    const limit=raw.limit??50;if(!Number.isInteger(limit)||limit<1||limit>100)fail();
    return {...raw,limit};
  }catch{return fail();}
}
export function traceMatches(row:GatewayRequestTrace,q:GatewayTraceQuery){
  return (!q.requestId||row.requestId===q.requestId)&&(!q.traceId||row.traceId===q.traceId)&&(!q.subjectId||row.identity?.subjectId===q.subjectId)&&(!q.serviceId||row.route?.serviceId===q.serviceId)&&(!q.poolId||row.route?.poolId===q.poolId)&&(!q.from||row.startedAt>=q.from)&&(!q.to||row.startedAt<q.to)&&(!q.state||(q.state==='active'?!row.completedAt:q.state==='ended'?!!row.completedAt:(row.status??0)>=400||!!row.errorCode))&&(!q.cursor||row.startedAt<q.cursor.at||row.startedAt===q.cursor.at&&row.attemptId<q.cursor.id);
}
