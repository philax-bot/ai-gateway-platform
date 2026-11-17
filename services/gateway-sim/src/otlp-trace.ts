import type {GatewayRequestTrace} from '@ai-gateway/contracts';
const ns=(iso:string)=>(BigInt(Date.parse(iso))*1000000n).toString();
/** OTLP/HTTP JSON: a server span with factual stage events, no prompt, response or credential. */
export function otlpTrace(row:GatewayRequestTrace){
  const attributes=Object.entries({'http.request.method':row.method,'url.path':row.path,'http.response.status_code':row.status,'atlas.request.id':row.requestId,'atlas.attempt.id':row.attemptId,'atlas.subject.id':row.identity?.subjectId,'atlas.credential.id':row.identity?.credentialId,'atlas.pool.id':row.route?.poolId,'atlas.service.id':row.route?.serviceId,'gen_ai.request.model':row.modelId,'gen_ai.response.model':row.route?.upstreamModel,'atlas.upstream.request.id':row.upstreamRequestId,'error.type':row.errorCode}).filter(([,v])=>v!==null&&v!==undefined).map(([key,value])=>({key,value:typeof value==='number'?{intValue:String(value)}:{stringValue:String(value)}}));
  return {resourceSpans:[{resource:{attributes:[{key:'service.name',value:{stringValue:'atlas-gateway'}}]},scopeSpans:[{scope:{name:'atlas.gateway',version:'1'},spans:[{traceId:row.traceId,spanId:row.spanId,...(row.parentSpanId?{parentSpanId:row.parentSpanId}:{}),name:`${row.method} ${row.path}`,kind:2,startTimeUnixNano:ns(row.startedAt),endTimeUnixNano:ns(row.completedAt??row.updatedAt),attributes,events:row.stages.map(e=>({name:e.stage,timeUnixNano:ns(e.at)})),status:{code:row.errorCode||(row.status??0)>=500?2:1}}]}]}]};
}
export function otlpExporter(endpoint=process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT){
  if(!endpoint)return async(_row:GatewayRequestTrace)=>true;
  const url=new URL(endpoint);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('invalid OTLP traces endpoint');
  return async(row:GatewayRequestTrace)=>{
    if(!row.completedAt)return true;
    try{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(otlpTrace(row)),signal:AbortSignal.timeout(3000),redirect:'error'});
      if(!r.ok){await r.body?.cancel();return false;}const body=await r.text();if(!body)return true;const result=JSON.parse(body) as {partialSuccess?:{rejectedSpans?:number|string}};return Number(result.partialSuccess?.rejectedSpans??0)===0;
    }catch{return false;}
  };
}
