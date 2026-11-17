import {BadRequestException,ForbiddenException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import {estimateChatInput,extractUpstreamUsage,meteredQuantity,modelEndpoint,protocolUrl,readUpstreamRequestId,type ModelKind,type ModelService,type PriceSnapshot,type VerificationMappingResult,type WorkspaceState} from '@ai-gateway/contracts';
import type {DemoStore} from '../store/demo.store';
import {costForUsage} from '../store/admission';
import {activeMember,operator,pick} from './validation';
import {frozenServiceCredential,routeSecret} from './upstream-credentials';
import {fetchVerifiedUpstream,probeProtocol,verificationMappingSnapshots,verificationPrice,verificationTimeoutMs,verificationProbeRequest} from './verification';

type Probe='basic'|'stream'|'tools'|'actual';
const prompt='Connection validation';
const rerankDocuments=[prompt,'Another document'];

function diagnosticPrice(service:ModelService,mapping:ModelService['mappings'][number]):PriceSnapshot|null {
  if(!mapping.meter)return verificationPrice(service.id,service.configVersion,mapping);
  if(mapping.meter.costPrice===null||mapping.meter.costPrice===undefined)return null;
  return {version:`acceptance-${service.id}-${service.configVersion}`,currency:'CNY',unit:mapping.meter.unit,inputPrice:0,outputPrice:0,cachedInputPrice:0,meter:{unit:mapping.meter.unit,price:mapping.meter.costPrice,multiplier:1}};
}

export async function runModelAcceptance(state:WorkspaceState,store:DemoStore,actorId:string,serviceId:string,input:Record<string,unknown>){
  operator(activeMember(state,actorId),'verification.run');
  if(!input||typeof input!=='object'||Array.isArray(input))throw new BadRequestException('invalid acceptance request');
  const service=pick(state.services,serviceId,'service');
  const mapping=service.mappings.find(item=>item.definitionId===input.definitionId);
  if(!mapping)throw new BadRequestException('mapping not found');
  const definition=pick(state.definitions,mapping.definitionId,'definition'),kind=definition.kind??'chat';
  const probe=input.probe as Probe;
  if(!['basic','stream','tools','actual'].includes(probe)||kind==='chat'&&probe==='actual'||kind!=='chat'&&probe!=='actual')throw new BadRequestException('probe does not match this model kind');
  if(kind==='video')throw new BadRequestException('asynchronous video acceptance uses the persistent multimodal workbench task flow');
  const target=new URL(service.baseUrl);
  if(!['localhost','127.0.0.1','[::1]'].includes(target.hostname)&&process.env.ALLOW_UPSTREAM_VALIDATION!=='true')throw new ForbiddenException('external model requests require explicit environment enablement');
  if(typeof input.maxCost!=='number'||!Number.isFinite(input.maxCost)||input.maxCost<0||input.maxCost>1e6)throw new BadRequestException('a diagnostic cost cap is required');
  if(typeof input.idempotencyKey!=='string'||input.idempotencyKey.length<8||input.idempotencyKey.length>160)throw new BadRequestException('idempotency key required');
  const price=diagnosticPrice(service,mapping);
  if(!price)throw new BadRequestException('请先在模型服务的“调整计价”中补齐当前模型的上游成本价，再执行验收；免费请填 0。');
  const quantity=mapping.meter?.unit==='per_1000_characters'?prompt.length:1;
  const inputText=kind==='rerank'?prompt+'\n'+rerankDocuments.join('\n'):kind==='asr'?'':prompt;
  const requestEstimate=kind==='chat'?verificationProbeRequest('chat',mapping.upstreamModel,probe as 'basic'|'stream'|'tools'):{messages:[{role:'user',content:inputText}]};
  const estimate=costForUsage(price,estimateChatInput(requestEstimate),probe==='tools'?64:1,0,mapping.meter?{unit:mapping.meter.unit,quantity}:undefined);
  if(estimate>input.maxCost)throw new BadRequestException('estimated diagnostic cost exceeds cap');
  const snapshots=verificationMappingSnapshots([{...mapping,kind}]);
  snapshots[0].protocols=kind==='chat'?['chat']:undefined;
  snapshots[0].probe=probe;
  snapshots[0].credential=frozenServiceCredential(state,service.credentialId);
  snapshots[0].requestFingerprint=createHash('sha256').update(JSON.stringify([actorId,mapping.definitionId,probe,input.maxCost])).digest('hex');
  const {run,replayed}=await store.startVerification({operatorId:actorId,serviceId,serviceName:service.name,configVersion:service.configVersion,mappings:snapshots,idempotencyKey:input.idempotencyKey});
  if(replayed)return {run,replayed:true,estimatedCost:estimate,maxCost:input.maxCost};
  let completed:'completed'|'interrupted'='completed';
  try{
    const secret=routeSecret(state,{credential:snapshots[0].credential,credentialRef:service.credentialRef});
    await store.markVerificationAttempt(run.id,mapping.definitionId);
    const result=kind==='chat'?await probeProtocol('chat',protocolUrl(service.baseUrl,'chat',service.protocolPaths),mapping.upstreamModel,secret,false,mapping,price,probe as 'basic'|'stream'|'tools'):
      await probeActualMedia(service,mapping,kind,secret,price);
    await store.appendVerificationResult(run.id,result);
  }catch{completed='interrupted';}
  return {run:await store.finishVerification(run.id,completed),replayed:false,estimatedCost:estimate,maxCost:input.maxCost};
}

async function probeActualMedia(service:ModelService,mapping:ModelService['mappings'][number],kind:ModelKind,secret:string,price:PriceSnapshot):Promise<VerificationMappingResult>{
  const base={definitionId:mapping.definitionId,upstreamModel:mapping.upstreamModel};
  let httpStatus:number|null=null,upstreamRequestId:string|null=null;
  try{
    const body:Record<string,unknown>={model:mapping.upstreamModel};
    if(kind==='embeddings')body.input=prompt;
    if(kind==='rerank')Object.assign(body,{query:prompt,documents:rerankDocuments,top_n:1});
    if(kind==='image')Object.assign(body,{prompt,n:1});
    if(kind==='tts')Object.assign(body,{input:prompt,voice:'alloy',response_format:'wav'});
    const headers:Record<string,string>=secret?{authorization:`Bearer ${secret}`}:{ };
    let data:BodyInit=JSON.stringify(body);
    if(kind==='asr'){
      const wav=Buffer.alloc(44+32000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
      const form=new FormData();form.set('model',mapping.upstreamModel);form.set('response_format','verbose_json');form.set('file',new Blob([wav],{type:'audio/wav'}),'acceptance.wav');data=form;
    }else headers['Content-Type']='application/json';
    const response=await fetchVerifiedUpstream(modelEndpoint(service.baseUrl,kind,undefined,service.modalityPaths?.[kind]),{method:'POST',body:data,headers,redirect:'error',signal:AbortSignal.timeout(verificationTimeoutMs())});
    httpStatus=response.status;upstreamRequestId=readUpstreamRequestId(response.headers);
    const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let bytes=0;
    try{if(reader)for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>32*1048576){await reader.cancel();throw new Error('response too large');}chunks.push(part.value);}}finally{reader?.releaseLock();}
    const content=Buffer.concat(chunks),value=kind==='tts'?null:JSON.parse(content.toString('utf8'));
    const valid=response.ok&&(kind==='tts'?bytes>0&&/audio\/|octet-stream/.test(response.headers.get('content-type')??''):kind==='asr'?typeof value?.text==='string':kind==='embeddings'?Array.isArray(value?.data)&&value.data.some((row:any)=>Array.isArray(row.embedding)&&row.embedding.length>0):kind==='rerank'?Array.isArray(value?.results)&&value.results.some((row:any)=>typeof row.relevance_score==='number'):Array.isArray(value?.data)&&value.data.length>0);
    const rawUsage=kind==='tts'?null:extractUpstreamUsage(content.toString('utf8'));
    const embeddingInput=kind==='embeddings'&&Number.isSafeInteger(value?.usage?.prompt_tokens)?value.usage.prompt_tokens:null;
    const usage=rawUsage??(embeddingInput!==null?{inputTokens:embeddingInput,outputTokens:0,cachedInputTokens:0}:null);
    const quantity=mapping.meter?meteredQuantity(mapping.meter.unit,kind,value,kind==='tts'?prompt.length:undefined):null;
    const known=valid&&(mapping.meter?quantity!==null:!!usage);
    const amount=known?costForUsage(price,usage?.inputTokens??0,usage?.outputTokens??0,usage?.cachedInputTokens??0,mapping.meter?{unit:mapping.meter.unit,quantity:quantity!}:undefined):null;
    return {...base,outcome:valid?'passed':'failed',support:valid?'supported':'unknown',httpStatus,errorCode:valid?null:'acceptance_failed',message:valid?'实际模态响应格式通过，计量证据单独记录':'响应状态或格式未通过验收',upstreamRequestId,
      usage:{inputTokens:usage?.inputTokens??null,outputTokens:usage?.outputTokens??null,cachedInputTokens:usage?.cachedInputTokens??null,complete:known},
      ...(mapping.meter&&quantity!==null?{meteredUsage:{unit:mapping.meter.unit,quantity}}:{}),cost:{state:known?'priced':'usage_unknown',amount,price},completedAt:new Date().toISOString()};
  }catch{return {...base,outcome:'failed',support:'unknown',httpStatus,errorCode:'acceptance_interrupted',message:'验收中断，用量待确认，不会自动重发生成请求',upstreamRequestId,usage:{inputTokens:null,outputTokens:null,cachedInputTokens:null,complete:false},cost:{state:'usage_unknown',amount:null,price},completedAt:new Date().toISOString()};}
}
