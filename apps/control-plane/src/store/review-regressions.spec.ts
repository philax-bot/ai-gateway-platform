import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {AuthorizeRequest,ModelKind,MediaJob} from '@ai-gateway/contracts';
import {DemoStore} from './demo.store';
import {WorkspaceRepository} from '../platform/workspace.repository';
import {PlatformService} from '../platform/platform.service';
import {billingView} from '../platform/billing-visibility';
import {scopedAuthorizationKey} from './accounting';
import {jobUpdate} from './media-jobs';

const operator='operator-demo-001',employee='employee-demo-001',range={poolId:'pool-local-test',mode:'follow',definitionIds:[]};
afterEach(()=>vi.restoreAllMocks());
async function fixture(kind:ModelKind='chat'){
  const store=new DemoStore(),repo=new WorkspaceRepository(store);await repo.initialize();store.businessState=()=>repo.read();const platform=new PlatformService(repo,store);
  async function command(type:string,payload:Record<string,unknown>,actor=operator){const c={type,payload,idempotencyKey:randomUUID()},preview=await platform.preview(actor,c);return (await platform.execute(actor,{...c,previewToken:preview.previewToken})).result as any;}
  await repo.transact(async tx=>{const s=tx.state;s.settings.limits={mode:'none'};s.definitions[0].kind=kind;s.services[0].verification='passed';s.pools[0].entries[0].open=true;if(kind==='video')s.services[0].mappings[0].meter={unit:'per_second',price:0.2,estimatedUnits:2,maxUnits:60};});
  async function app(name='Regression app'){
    const a=await command('save.application',{name,ownerId:employee,organizationId:'org-demo',range});const issued=await command('key.issue',{name,purpose:'application',applicationId:a.id},employee),credential=(await store.getDemoCredential(issued.secret))!;
    const input=(patch:Partial<AuthorizeRequest>={}):AuthorizeRequest=>({requestId:randomUUID(),idempotencyKey:randomUUID(),identity:credential.identity,purpose:'application',modelId:'test-model',mode:kind,estimatedInputTokens:1,maxOutputTokens:1,policyVersion:'review-regression',...patch});
    return {issued,input,credential};
  }
  async function video(){const a=await app(),input=a.input({estimatedUnits:2}),decision=await store.authorize(input);expect(decision.decision).toBe('allow');const job=await store.createMediaJob({id:randomUUID(),requestId:input.requestId,reservationId:decision.reservation!.reservationId});await store.mediaJobReceipt({id:job.id,upstreamId:'vendor-'+job.id,status:'queued',result:null});return (await store.getMediaJob(job.id))!;}
  return {store,repo,platform,command,app,video};
}
describe('reviewed storage and business boundary regressions',()=>{
  it('keeps cancellation and progress when the original receipt is delivered again',async()=>{
    const f=await fixture('video'),job=await f.video();await f.store.updateMediaJob({id:job.id,status:'in_progress',result:{progress:50,cancel_requested:true,cancel_uncertain:false}});
    await f.store.mediaJobReceipt({id:job.id,upstreamId:job.upstreamId!,status:'queued',result:null});expect(await f.store.getMediaJob(job.id)).toMatchObject({status:'in_progress',result:{progress:50,cancel_requested:true,cancel_uncertain:false}});
  });
  it('atomically claims one cancellation and rejects stale polling writes',async()=>{
    const f=await fixture('video'),job=await f.video(),tokens=[randomUUID(),randomUUID()];
    const claims=await Promise.all(tokens.map(token=>f.store.claimMediaCancellation(job.id,token)));expect(claims.filter(c=>c.claimed)).toHaveLength(1);const token=tokens[claims.findIndex(c=>c.claimed)];
    expect(await f.store.updateMediaJob({id:job.id,status:'in_progress',result:{progress:30},expectedRevision:job.revision})).toEqual({recorded:false});
    await f.store.updateMediaJob({id:job.id,status:'in_progress',cancelToken:token,result:{cancel_requested:true,cancel_uncertain:false}});
    expect((await f.store.getMediaJob(job.id))!.result).toMatchObject({cancel_requested:true,cancel_uncertain:false});expect((await f.store.claimMediaCancellation(job.id,randomUUID())).claimed).toBe(false);
  });
  it('recovers an expired cancellation lease and ignores a superseded acknowledgement',async()=>{
    const f=await fixture('video'),job=await f.video(),first=randomUUID(),second=randomUUID(),now=Date.now();await f.store.claimMediaCancellation(job.id,first);
    vi.spyOn(Date,'now').mockReturnValue(now+31000);expect((await f.store.claimMediaCancellation(job.id,second)).claimed).toBe(true);
    expect(await f.store.updateMediaJob({id:job.id,status:'in_progress',cancelToken:first,result:{cancel_requested:true,cancel_uncertain:false}})).toEqual({recorded:false});
    expect((await f.store.getMediaJob(job.id))!.cancelOperation?.token).toBe(second);
  });
  it('selects live callback destinations before applying the candidate limit',async()=>{
    const f=await fixture('video'),job=await f.video();for(let i=0;i<101;i++){const id=randomUUID();(f.store as any).mediaJobs.set(id,{...job,id,status:'completed',finishedAt:new Date().toISOString(),settled:true,callbackChannelId:i===100?'live':'disabled'} as MediaJob);}
    const candidates=await f.store.pendingMediaCallbacks(['live']);expect(candidates).toHaveLength(1);expect(candidates[0].callbackChannelId).toBe('live');expect(await f.store.pendingMediaCallbacks([])).toEqual([]);
  });
  it('checks managed key expiry during credential resolution without another synchronization',async()=>{
    const f=await fixture(),a=await f.app();await f.repo.transact(async tx=>{tx.state.keys.find(k=>k.id===a.issued.key.id)!.expiresAt=new Date(Date.now()-1).toISOString();});expect(await f.store.getDemoCredential(a.issued.secret)).toBeNull();
  });
  it('uses the largest Embedding input for context and the total for capacity',async()=>{
    const f=await fixture('embeddings'),a=await f.app();await f.repo.transact(async tx=>{tx.state.definitions[0].contextTokens=8192;});
    const accepted=await f.store.authorize(a.input({estimatedInputTokens:9216,maxInputTokens:1024}));expect(accepted.decision).toBe('allow');expect(accepted.admission!.estimatedTokens).toBe(9216);
    expect((await f.store.authorize(a.input({estimatedInputTokens:8192,maxInputTokens:8192}))).decision).toBe('allow');expect((await f.store.authorize(a.input({estimatedInputTokens:8193,maxInputTokens:8193}))).reasonCode).toBe('request_limit_exceeded');
  });
  it('isolates client authorization and settlement keys while preserving replay and conflicts',async()=>{
    const f=await fixture(),one=await f.app('one'),two=await f.app('two'),key=randomUUID(),a=one.input({idempotencyKey:key}),b=two.input({idempotencyKey:key});
    const aa=await f.store.authorize(a),bb=await f.store.authorize(b);expect(aa.decision).toBe('allow');expect(bb.decision).toBe('allow');expect((await f.store.authorize({...a,requestId:randomUUID()})).replayed).toBe(true);
    await expect(f.store.authorize({...a,requestId:randomUUID(),estimatedInputTokens:2})).rejects.toThrow('different input');
    for(const [input,decision]of [[a,aa],[b,bb]] as const)await f.store.settle({requestId:input.requestId,idempotencyKey:'independent-client-final',reservationId:decision.reservation!.reservationId,outcome:'completed',forwarded:true,usageFinal:true,inputTokens:1,outputTokens:1,cachedInputTokens:0,completedAt:new Date().toISOString()});expect(f.store.callLogs.filter(c=>[a.requestId,b.requestId].includes(c.requestId))).toHaveLength(2);
  });
  it('replays a legacy unscoped authorization in the same credential scope',async()=>{
    const f=await fixture(),a=await f.app(),input=a.input();await f.store.authorize(input);const scoped=scopedAuthorizationKey(input),entry=f.store.authorizationInputs.get(scoped)!;f.store.authorizationInputs.delete(scoped);f.store.authorizationInputs.set(input.idempotencyKey,entry);expect((await f.store.authorize({...input,requestId:randomUUID()})).replayed).toBe(true);
  });
  it('requires explicit approval repair after the selected plan version changes',async()=>{
    const f=await fixture(),payload={name:'Approved plan',amount:10,cadence:'once',quotaDays:30,entitlementDays:365,range},plan=await f.command('save.plan',payload),expiresAt=new Date(Date.now()+86400000).toISOString();
    const approval=await f.command('approval.submit',{kind:'personal_open',amount:5,expiresAt,scenario:'Office',reason:'one time'},employee);await f.command('approval.decide',{id:approval.id,decision:'approve',reason:'approved',planId:plan.id});
    await f.command('save.plan',{...payload,id:plan.id,amount:100,cadence:'monthly'});await expect(f.command('approval.execute',{id:approval.id})).rejects.toThrow('方案版本');expect((await f.repo.read()).entitlements).toHaveLength(0);
    await f.command('approval.repair',{id:approval.id,reason:'Approve changed monthly plan'});await f.command('approval.execute',{id:approval.id});expect((await f.repo.read()).entitlements[0].planVersion).toBe(2);
  });
  it('corrects the original TPM window when final usage is manually confirmed',async()=>{
    const f=await fixture(),a=await f.app();await f.repo.transact(async tx=>{const s=tx.state;s.definitions[0].estimatedOutputTokens=10;s.services[0].limits={mode:'custom',tpm:120};});const input=a.input({estimatedInputTokens:10,maxOutputTokens:100}),decision=await f.store.authorize(input);expect(decision.admission!.estimatedTokens).toBe(20);
    await f.store.settle({requestId:input.requestId,idempotencyKey:randomUUID(),reservationId:decision.reservation!.reservationId,outcome:'partial',forwarded:true,usageFinal:false,inputTokens:0,outputTokens:0,cachedInputTokens:0,completedAt:new Date().toISOString()});
    await f.command('usage.reconcile',{requestId:input.requestId,reason:'Confirmed actual usage',mode:'confirm_usage',inputTokens:10,outputTokens:90,cachedInputTokens:0});
    const scope=decision.admission!.scopes.find(s=>s.id.includes(':service:'))!.id;expect((await f.store.capacityCounters([scope])).rows[0].tokens).toBe(100);expect((await f.store.authorize(a.input({estimatedInputTokens:10,maxOutputTokens:100}))).decision).toBe('allow');expect((await f.store.authorize(a.input({estimatedInputTokens:10,maxOutputTokens:100}))).reasonCode).toBe('rate_limited');
  });
  it('hides derived costs and historical diagnostic amounts while retaining public prices',()=>{
    const value={inputPrice:2,beforeCost:'123 / 456 / 78',afterCost:99,multiplier:1.5,verificationMessage:'内部诊断成本 0.05058 元已记录',verificationRun:{mappings:[{attemptedAt:null,upstreamModel:'physical',inputPrice:123,outputPrice:456,cachedInputPrice:78}],results:[{cost:{amount:0.05058}}]}};
    const publicValue=billingView(value,false,true) as any;expect(publicValue.inputPrice).toBe(2);expect(publicValue.beforeCost).toBeUndefined();expect(publicValue.multiplier).toBeUndefined();expect(publicValue.verificationRun.mappings[0].inputPrice).toBeUndefined();expect(JSON.stringify(publicValue)).not.toContain('0.05058');expect(billingView(value,true)).toEqual(value);
  });
  it('still releases estimated TPM after authoritative late evidence of no forwarding',async()=>{
    const f=await fixture(),a=await f.app(),input=a.input({estimatedInputTokens:10,maxOutputTokens:10}),decision=await f.store.authorize(input),scope=decision.admission!.scopes.find(s=>s.id.includes(':service:'))!.id;
    const base={requestId:input.requestId,reservationId:decision.reservation!.reservationId,inputTokens:0,outputTokens:0,cachedInputTokens:0,completedAt:new Date().toISOString()};
    await f.store.settle({...base,idempotencyKey:input.requestId+':lease-expired',outcome:'partial',usageFinal:false});expect((await f.store.capacityCounters([scope])).rows[0].tokens).toBe(20);
    await f.store.settle({...base,idempotencyKey:randomUUID(),outcome:'rejected_before_upstream',forwarded:false,usageFinal:true});expect((await f.store.capacityCounters([scope])).rows[0].tokens).toBe(0);
  });
  it('rejects malformed revisions and operation tokens at the persistence boundary',()=>{
    expect(()=>jobUpdate(undefined as any)).toThrow('invalid job id');expect(()=>jobUpdate({id:randomUUID(),status:'queued',result:null,expectedRevision:-1})).toThrow('revision');expect(()=>jobUpdate({id:randomUUID(),status:'queued',result:null,cancelToken:'bad'})).toThrow('job id');
  });
});
