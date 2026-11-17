import {describe,it,expect} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {initialWorkspace} from '../platform/seed';
import {DemoStore} from './demo.store';
import {rankRoutes} from './pool-routing';
import {costForUsage} from './admission';
import {aggregateUsage} from './call-analytics';
import {meterPrice,modalityPaths,poolRouting} from '../platform/model-configuration';
import type {AdmissionSnapshot,AuthorizeRequest,ModelKind,Plan} from '@ai-gateway/contracts';
import {resourceAction} from '../platform/resource-actions';
import type {WorkspaceTransaction} from '../platform/workspace.repository';
import {WorkspaceRepository} from '../platform/workspace.repository';
import {PlatformService} from '../platform/platform.service';
import {jobResult} from './media-jobs';
function setup(kind:ModelKind='image'){
  const store=new DemoStore(),state=initialWorkspace(),identity=store.credentials.get('local-employee-key')!.identity;
  state.definitions[0].kind=kind;state.services[0].verification='passed';state.pools[0].entries[0].open=true;state.settings.limits={mode:'none'};
  state.services[0].mappings[0].meter={unit:kind==='tts'?'per_1000_characters':kind==='video'?'per_second':'per_image',price:0.2,costPrice:0.1,estimatedUnits:2,maxUnits:10000};
  state.definitions[0].billingMultiplier=1.5;
  const plan:Plan={id:'plan-media',version:1,name:'多模态',range:{poolId:state.pools[0].id,mode:'follow',definitionIds:[]},amount:10,cadence:'once',quotaDays:30,entitlementDays:365,active:true,limits:{mode:'inherit'}};
  state.entitlements.push({id:'ent-media',memberId:identity.subjectId,planId:plan.id,planVersion:1,planSnapshot:plan,range:plan.range,grantedAt:new Date().toISOString(),expiresAt:'2099-01-01T00:00:00Z',status:'active',futureGrants:true,source:'manual',ruleIds:[],periods:['once']});
  state.keys.push({id:'key-media',credentialId:identity.credentialId,name:'媒体测试',ownerId:identity.subjectId,subjectType:'employee',subjectId:identity.subjectId,purpose:'personal',projectId:null,masked:'test',keyHash:'test-only',status:'active',createdAt:new Date().toISOString(),expiresAt:'2099-01-01T00:00:00Z',lastUsedAt:null});
  const batch=store.quotaBatches.get('personal-batch-demo-001')!;batch.entitlementId='ent-media';batch.expiresAt='2099-01-01T00:00:00Z';store.businessState=async()=>structuredClone(state);
  const request=(patch:Partial<AuthorizeRequest>={}):AuthorizeRequest=>({requestId:randomUUID(),idempotencyKey:randomUUID(),identity,purpose:'personal',modelId:'test-model',mode:kind,estimatedInputTokens:10,estimatedUnits:2,policyVersion:'test-media',...patch});
  return {store,state,request,batch};
}
describe('multimodal admission and billing',()=>{
  it('quotes and displays an affordable source even when the first source exceeds the remaining balance',async()=>{
    const {store,state,batch,request}=setup(),identity=request().identity;
    state.definitions[0].billingMultiplier=1;
    const second=structuredClone(state.services[0]);second.id='affordable-source';state.services.push(second);
    state.pools[0].entries.push({definitionId:state.definitions[0].id,serviceId:second.id,open:true});
    const ordered=[state.services[0],second].sort((a,b)=>createHash('sha256').update(`view:${a.id}`).digest('hex').localeCompare(createHash('sha256').update(`view:${b.id}`).digest('hex')));
    ordered[0].mappings[0].meter={unit:'per_image',price:10,estimatedUnits:1,maxUnits:10};
    ordered[1].mappings[0].meter={unit:'per_image',price:0.1,estimatedUnits:1,maxUnits:10};
    batch.totalAmount=1;batch.availableAmount=1;
    const application={id:'affordable-application',name:'多来源应用',description:'',billingMode:'quota' as const,ownerId:identity.subjectId,organizationId:'department-engineering',active:true,range:{poolId:state.pools[0].id,mode:'follow' as const,definitionIds:[]},limits:{mode:'inherit' as const}};
    state.applications.push(application);
    store.quotaBatches.set('affordable-application-batch',{...structuredClone(batch),id:'affordable-application-batch',sourceType:'application_wallet',sourceId:application.id,purpose:'application',entitlementId:null});
    const repository=new WorkspaceRepository(store);await repository.initialize();
    await repository.transact(async tx=>{Object.assign(tx.state,structuredClone(state));});
    const platform=new PlatformService(repository,store);
    expect((await platform.snapshot(identity.subjectId)).purposes[0].models[0].status).toBe('ready');
    expect((await platform.applicationDetail(identity.subjectId,application.id)).models[0].status).toBe('ready');
    const payload={purpose:'personal',model:'test-model',messages:[{role:'user',content:'one image'}],estimatedUnits:1};
    const quote=await platform.quote(identity.subjectId,payload);
    expect(quote).toMatchObject({decision:'allow',reservedAmount:0.1});
    const admitted=await store.authorize(request({estimatedUnits:1,expectedPriceVersion:quote.price!.version}));
    expect(admitted).toMatchObject({decision:'allow',admission:{route:{serviceId:ordered[1].id}},reservation:{reservedAmount:0.1}});
    batch.availableAmount=0.05;
    expect(await platform.quote(identity.subjectId,payload)).toMatchObject({decision:'deny',reasonCode:'quota_insufficient'});
    expect((await platform.snapshot(identity.subjectId)).purposes[0].models[0].status).toBe('quota_insufficient');
  });
  it('preserves an uncertain cancellation across task persistence and rejects invalid indicators',()=>{
    expect(jobResult({cancel_requested:true,cancel_uncertain:true})).toEqual({cancel_requested:true,cancel_uncertain:true});
    expect(()=>jobResult({cancel_uncertain:'true'})).toThrow('invalid cancellation indicator');
  });
  it('freezes quantity prices and costs, settles actual images once and releases unused hold',async()=>{
    const {store,state,request,batch}=setup(),input=request(),auth=await store.authorize(input);expect(auth.decision).toBe('allow');expect(auth.reservation?.reservedAmount).toBe(0.6);
    state.services[0].mappings[0].meter!.price=99;state.definitions[0].billingMultiplier=3;
    const event={requestId:input.requestId,idempotencyKey:'image-final',reservationId:auth.reservation!.reservationId,outcome:'completed' as const,forwarded:true,usageFinal:true,inputTokens:0,outputTokens:0,meteredUsage:{unit:'per_image' as const,quantity:1},completedAt:new Date().toISOString()};
    await store.settle(event);await store.settle(event);expect(batch.availableAmount).toBe(9.7);expect(store.callLogs).toHaveLength(1);expect(store.callLogs[0].meteredUsage?.quantity).toBe(1);
    expect(aggregateUsage(store.callLogs,{to:new Date(Date.now()+1000).toISOString()},null,'Asia/Shanghai').totals.cost!.knownAmount).toBe(0.1);
  });
  it('keeps missing or mismatched units pending and reconciles against the original unit',async()=>{
    const {store,request}=setup(),input=request(),auth=await store.authorize(input);
    await store.settle({requestId:input.requestId,idempotencyKey:'unknown-images',reservationId:auth.reservation!.reservationId,outcome:'completed',usageFinal:false,forwarded:true,completedAt:new Date().toISOString()});
    expect(store.callLogs[0].billableState).toBe('pending_review');
    const review={requestId:input.requestId,idempotencyKey:'review-images',actorId:'operator',reason:'供应商确认图片数',mode:'confirm_usage' as const,inputTokens:0,outputTokens:0};
    await expect(store.reconcileWithinBusinessTransaction({...review,meteredUsage:{unit:'per_second',quantity:2}})).rejects.toThrow('original unit');
    await store.reconcileWithinBusinessTransaction({...review,meteredUsage:{unit:'per_image',quantity:2}});expect(store.callLogs[0].actualAmount).toBe(0.6);expect(store.callLogs[0].meteredUsage?.quantity).toBe(2);
  });
  it('rejects type mismatch, disabled suppliers and requests over metered limits',async()=>{
    const {store,state,request}=setup();expect((await store.authorize(request({mode:'chat'}))).decision).toBe('deny');
    expect((await store.authorize(request({estimatedUnits:10001}))).reasonCode).toBe('request_limit_exceeded');
    state.providers=[{id:'openai-compatible',name:'停用',description:'',baseUrl:'',adapter:'openai',kinds:['image'],active:false}];expect((await store.authorize(request())).reasonCode).toBe('service_unavailable');
  });
  it('counts raw characters and rounds micro-CNY only once',async()=>{
    const {store,request}=setup('tts'),auth=await store.authorize(request({estimatedUnits:1001}));expect(auth.reservation?.reservedAmount).toBe(0.3003);
    expect(costForUsage(auth.admission!.price!,0,0,0,{unit:'per_1000_characters',quantity:1})).toBe(0.0003);
  });
  it('persists video ownership and terminal evidence, leases workers exclusively and never reopens a finished task',async()=>{
    const {store,request}=setup('video'),input=request(),auth=await store.authorize(input),id=randomUUID();
    const job=await store.createMediaJob({id,requestId:input.requestId,reservationId:auth.reservation!.reservationId});expect(job.identity).toEqual(input.identity);expect(job.meterUnit).toBe('per_second');
    expect(await store.createMediaJob({id:randomUUID(),requestId:input.requestId,reservationId:auth.reservation!.reservationId})).toEqual(job);
    expect(await store.claimMediaJobs('one')).toHaveLength(1);expect(await store.claimMediaJobs('two')).toHaveLength(0);
    await store.mediaJobReceipt({id,upstreamId:'vendor-job',status:'queued',result:null});
    await store.updateMediaJob({id,status:'completed',result:{seconds:2,url:'https://example.org/video.mp4'}});const finished=await store.getMediaJob(id);
    await store.mediaJobReceipt({id,upstreamId:'vendor-job',status:'queued',result:null});await store.updateMediaJob({id,status:'completed',result:{seconds:99}});
    expect(await store.getMediaJob(id)).toEqual(finished);await store.updateMediaJob({id,status:'completed',result:null,settled:true});expect(await store.claimMediaJobs('three')).toHaveLength(0);
  });
});
describe('model configuration boundaries',()=>{
  it('does not expose custom supplier addresses in employee snapshots',async()=>{
    const store=new DemoStore(),repository=new WorkspaceRepository(store),platform=new PlatformService(repository,store);
    await repository.transact(async tx=>{tx.state.providers=[{id:'private-provider',name:'内部服务',description:'',baseUrl:'https://private.example/v1',adapter:'openai',kinds:['chat'],active:true}];});
    expect((await platform.snapshot('employee-demo-001')).providers).toEqual([]);
    expect((await platform.snapshot('operator-demo-001')).providers?.some(p=>p.id==='private-provider')).toBe(true);
  });
  it('invalidates legacy supplier bindings and clears incompatible prices when a model changes type',async()=>{
    const {state}=setup(),tx={state} as WorkspaceTransaction,actor=state.members.find(m=>m.roles.includes('operator'))!;
    const version=state.services[0].configVersion;
    await resourceAction(tx,actor,'save.provider',{id:'openai-compatible',name:'兼容服务',adapter:'xai',kinds:['image','tts'],active:true});
    expect(state.services[0].configVersion).toBe(version+1);expect(state.services[0].verification).toBe('unverified');
    await resourceAction(tx,actor,'save.definition',{...state.definitions[0],kind:'tts'});expect(state.services[0].mappings[0]).toMatchObject({inputPrice:null,outputPrice:null,cachedInputPrice:null,costPrice:null});expect(state.services[0].mappings[0].meter).toBeUndefined();
  });
  it('limits pricing units, quantities and endpoint overrides',()=>{
    expect(()=>meterPrice({unit:'per_second',price:1,estimatedUnits:1,maxUnits:3},'image')).toThrow();expect(()=>meterPrice({unit:'per_image',price:1,estimatedUnits:4,maxUnits:3},'image')).toThrow();
    expect(()=>modalityPaths({video:'https://other.example/tasks'})).toThrow();expect(()=>modalityPaths({video:'/../secret'})).toThrow();expect(modalityPaths({video:'/api/tasks/{id}'})).toEqual({video:'/api/tasks/{id}'});
    expect(()=>poolRouting({strategy:'random-untrusted',failureThreshold:1,cooldownSeconds:30})).toThrow();
  });
});
describe('pool routing',()=>{
  function candidates(strategy:'weighted'|'least_busy'|'usage'|'priority'|'latency'){
    const {state}=setup(),base:AdmissionSnapshot={kind:'configured',price:null,route:null,reservedAmount:0,estimatedTokens:0,scopes:[]};state.pools[0].routing={strategy,failureThreshold:3,cooldownSeconds:30};
    const choices=['one','two'].map(serviceId=>({admission:{...base,route:{serviceId,definitionId:'d',poolId:state.pools[0].id,upstreamModel:'physical',baseUrl:'http://localhost',credentialRef:null},scopes:[{id:`tenant:service:${serviceId}`,concurrency:10,rpm:100}]}}));
    state.pools[0].entries=choices.map((c,i)=>({definitionId:'d',serviceId:c.admission.route.serviceId,open:true,weight:i?1:3,priority:i?1:0}));return {state,choices};
  }
  it('distributes deterministic weighted requests approximately 3:1',()=>{const {state,choices}=candidates('weighted');let first=0;for(let i=0;i<4000;i++)if(rankRoutes(choices,state,[],[],String(i))[0].admission.route.serviceId==='one')first++;expect(first).toBeGreaterThan(2850);expect(first).toBeLessThan(3150);expect(rankRoutes(choices,state,[],[],'replay')).toEqual(rankRoutes(choices,state,[],[],'replay'));});
  it('uses only the current model candidates for cold-start latency estimates',()=>{
    const {state,choices}=candidates('latency');
    const observations=[{serviceId:'one',definitionId:'d',failures:0,recent:3,failedAt:Date.now(),latency:100,samples:3},{serviceId:'one',definitionId:'unrelated-model',failures:0,recent:100,failedAt:Date.now(),latency:1,samples:100}];
    rankRoutes(choices,state,[],observations,'cold-start');
    const decision=(choices[0].admission as AdmissionSnapshot).routing!;
    expect(decision.candidates?.find(row=>row.serviceId==='two')?.score).toBe(100);
  });
  it('uses authoritative active and minute counters, then applies priority and health cooldown',()=>{
    const {state,choices}=candidates('least_busy'),counts=[{id:'tenant:service:one',active:9,requests:90,tokens:0},{id:'tenant:service:two',active:0,requests:1,tokens:0}];expect(rankRoutes(choices,state,counts,[],'id')[0].admission.route.serviceId).toBe('two');
    state.pools[0].routing!.strategy='usage';expect(rankRoutes(choices,state,counts,[],'id')[0].admission.route.serviceId).toBe('two');state.pools[0].routing!.strategy='priority';expect(rankRoutes(choices,state,counts,[],'id')[0].admission.route.serviceId).toBe('one');
    const observations=[{serviceId:'one',definitionId:'d',failures:3,recent:3,failedAt:Date.now(),latency:null,samples:0}];expect(rankRoutes(choices,state,counts,observations,'id')[0].admission.route.serviceId).toBe('two');expect(rankRoutes(choices,state,counts,observations,'id',Date.now()+31000)[0].admission.route.serviceId).toBe('one');
  });
});
