import {beforeEach,describe,expect,it} from 'vitest';
import type {AuthorizeRequest,PlatformCommand} from '@ai-gateway/contracts';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {PlatformService} from './platform.service';
import {AuthService} from './auth.service';
import {hash} from './validation';
import {publicKey,syncResources} from './domain';

const operator='operator-demo-001',employee='employee-demo-001',firstSession='online-session-a',otherSession='online-session-b';
type Credential=NonNullable<Awaited<ReturnType<DemoStore['getDemoCredential']>>>;
const input=(credential:Credential,requestId:string):AuthorizeRequest=>({requestId,idempotencyKey:requestId,identity:credential.identity,purpose:credential.purpose,modelId:'test-model',mode:'chat',estimatedInputTokens:100,maxOutputTokens:32,policyVersion:'online-session-test'});

describe('online credentials follow the issuing login session',()=>{
  let store:DemoStore,repository:WorkspaceRepository,platform:PlatformService,auth:AuthService;
  async function command(type:string,payload:Record<string,unknown>,actor=operator){const c:PlatformCommand={type,payload,idempotencyKey:crypto.randomUUID()},preview=await platform.preview(actor,c);return (await platform.execute(actor,{...c,previewToken:preview.previewToken})).result as any;}
  beforeEach(async()=>{
    store=new DemoStore();repository=new WorkspaceRepository(store);await repository.initialize();platform=new PlatformService(repository,store);auth=new AuthService(repository);
    // Unit fixture; actual source verification is covered by the isolated Higress HTTP run.
    await repository.transact(async tx=>{
      tx.state.services[0].verification='passed';tx.state.services[0].mappings[0]={...tx.state.services[0].mappings[0],inputPrice:2,outputPrice:8,cachedInputPrice:.5};tx.state.pools[0].entries[0].open=true;
      for(const [token,duration] of [[firstSession,60000],[otherSession,3600000]] as const)tx.state.sessions.push({tokenHash:hash(token),memberId:employee,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+duration).toISOString()});
    });
    const plan=await command('save.plan',{name:'Online session test',range:{poolId:'pool-local-test',mode:'follow',definitionIds:[]},amount:1,cadence:'once',quotaDays:1,entitlementDays:1});await command('distribution.execute',{planId:plan.id,memberIds:[employee]});
  });
  it('revokes this session online identity while preserving another session and ordinary API Keys',async()=>{
    const first=await platform.onlineCredential(employee,{purpose:'personal'},firstSession),other=await platform.onlineCredential(employee,{purpose:'personal'},otherSession),ordinary=await command('key.issue',{name:'ordinary API Key',purpose:'personal'},employee);
    const credential=await store.getDemoCredential(first.token);expect(credential).not.toBeNull();
    await auth.logout(firstSession);
    expect(await store.getDemoCredential(first.token)).toBeNull();expect(await store.getDemoCredential(other.token)).not.toBeNull();expect(await store.getDemoCredential(ordinary.secret)).not.toBeNull();
    expect((await store.authorize(input(credential!,'logged-out-new-call'))).decision).toBe('deny');
    expect((await repository.read()).sessions.some(s=>s.tokenHash===hash(otherSession))).toBe(true);
  });
  it('cannot mint from an expired, foreign or concurrently logged-out session and caps expiry to the session',async()=>{
    const issued=await platform.onlineCredential(employee,{purpose:'personal'},firstSession),state=await repository.read(),session=state.sessions.find(s=>s.tokenHash===hash(firstSession))!;
    expect(issued.expiresAt).toBe(session.expiresAt);const keyCount=state.keys.length;
    await expect(platform.onlineCredential(operator,{purpose:'personal'},firstSession)).rejects.toThrow('session expired');
    await auth.authenticate(firstSession);await auth.logout(firstSession);
    await expect(platform.onlineCredential(employee,{purpose:'personal',onlineSessionHash:hash(otherSession)},firstSession)).rejects.toThrow('session expired');
    await repository.transact(async tx=>{tx.state.sessions.find(s=>s.tokenHash===hash(otherSession))!.expiresAt=new Date(Date.now()-1).toISOString();});
    await expect(platform.onlineCredential(employee,{purpose:'personal'},otherSession)).rejects.toThrow('session expired');expect((await repository.read()).keys).toHaveLength(keyCount);
  });
  it('keeps already admitted usage billable at its original price after logout',async()=>{
    const issued=await platform.onlineCredential(employee,{purpose:'personal'},firstSession),credential=(await store.getDemoCredential(issued.token))!,request=input(credential,'already-admitted'),admitted=await store.authorize(request);expect(admitted.decision).toBe('allow');
    await auth.logout(firstSession);
    const settled=await store.settle({requestId:request.requestId,idempotencyKey:'already-admitted-settlement',reservationId:admitted.reservation!.reservationId,outcome:'completed',forwarded:true,usageFinal:true,inputTokens:13,outputTokens:14,cachedInputTokens:4,completedAt:new Date().toISOString()});
    expect(settled.billableState).toBe('confirmed');expect((await store.listCalls()).find(c=>c.requestId===request.requestId)?.actualAmount).toBe(.000132);
  });
  it('does not expose session linkage and rejects legacy unbound internal identities',async()=>{
    const issued=await platform.onlineCredential(employee,{purpose:'personal'},firstSession),key=(await repository.read()).keys.find(k=>k.internal)!;
    expect(key.onlineSessionHash).toBe(hash(firstSession));expect(JSON.stringify(publicKey(key))).not.toContain('onlineSessionHash');expect(JSON.stringify(await platform.snapshot(employee))).not.toContain(hash(firstSession));expect(JSON.stringify(await repository.read())).not.toContain(firstSession);
    const credential=(await store.getDemoCredential(issued.token))!;
    await repository.transact(async tx=>{delete tx.state.keys.find(k=>k.id===key.id)!.onlineSessionHash;await syncResources(tx);});
    expect(await store.getDemoCredential(issued.token)).toBeNull();expect((await store.authorize(input(credential,'legacy-unbound-call'))).decision).toBe('deny');
  });
});
