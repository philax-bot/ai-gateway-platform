import { beforeEach,describe,it,expect } from 'vitest';
import type { PlatformCommand } from '@ai-gateway/contracts';
import { DemoStore } from '../store/demo.store';
import { WorkspaceRepository } from './workspace.repository';
import { PlatformService } from './platform.service';
import { hash } from './validation';
const operator='operator-demo-001',employee='employee-demo-001',range={poolId:'pool-local-test',mode:'follow',definitionIds:[]};
describe('scoped key details and integration data',()=>{
  let repo:WorkspaceRepository,platform:PlatformService;
  async function command(type:string,payload:Record<string,unknown>,actor=operator){const c:PlatformCommand={type,payload,idempotencyKey:crypto.randomUUID()},p=await platform.preview(actor,c);return (await platform.execute(actor,{...c,previewToken:p.previewToken})).result as any;}
  beforeEach(async()=>{const store=new DemoStore();repo=new WorkspaceRepository(store);await repo.initialize();platform=new PlatformService(repo,store);await repo.transact(async tx=>{tx.state.services[0].verification='passed';tx.state.pools[0].entries[0].open=true;});});
  it('returns purpose models, funding sources and history without exposing secret material',async()=>{
    const plan=await command('save.plan',{name:'个人方案',range,amount:10,cadence:'once',quotaDays:30,entitlementDays:365});await command('distribution.execute',{planId:plan.id,memberIds:[employee]});
    const issued=await command('key.issue',{name:'编程工具',purpose:'personal'},employee),detail=await platform.keyDetail(employee,issued.key.id);
    expect(detail.models).toEqual([{modelId:'test-model',name:'本地测试模型'}]);expect(detail.sources[0]).toMatchObject({name:'个人方案',planVersion:1,balance:10});expect(detail.history.map(h=>h.action)).toContain('key.issue');
    const json=JSON.stringify(detail);expect(json).not.toContain(issued.secret);expect(json).not.toContain('keyHash');expect(json).not.toContain('passwordHash');
    const unrelated=await command('save.member',{directoryId:'unrelated',name:'无关',organizationId:'org-demo'});await expect(platform.keyDetail(unrelated.id,issued.key.id)).rejects.toThrow('outside');
    await command('key.status',{id:issued.key.id,status:'revoked',reason:'测试吊销'},employee);expect((await platform.keyDetail(employee,issued.key.id)).history.map(h=>h.action)).toContain('key.status');
    expect((await platform.keyDetail(operator,issued.key.id)).key.status).toBe('revoked');
  });
  it('moves application key visibility with ownership and keeps the original issuance audit',async()=>{
    const next=await command('save.member',{directoryId:'new-owner',name:'新负责人',organizationId:'org-demo'}),app=await command('save.application',{name:'独立应用',ownerId:employee,organizationId:'org-demo',range});
    const issued=await command('key.issue',{name:'应用工具',purpose:'application',applicationId:app.id},employee);await command('save.application',{...app,ownerId:next.id});
    await expect(platform.keyDetail(employee,issued.key.id)).rejects.toThrow('outside');const detail=await platform.keyDetail(next.id,issued.key.id);expect(detail.key.ownerId).toBe(next.id);expect(detail.history.map(h=>h.action)).toEqual(expect.arrayContaining(['key.issue','save.application']));
    await command('save.member',{id:employee,directoryId:'employee',name:'停用原负责人',organizationId:'department-engineering',active:false});expect((await platform.keyDetail(next.id,issued.key.id)).sourceActive).toBe(true);
  });
  it('never exposes online internal identities as normal managed keys',async()=>{
    const plan=await command('save.plan',{name:'在线方案',range,amount:10,cadence:'once',quotaDays:30,entitlementDays:365});await command('distribution.execute',{planId:plan.id,memberIds:[employee]});
    const token='key-detail-online-session';await repo.transact(async tx=>{tx.state.sessions.push({tokenHash:hash(token),memberId:employee,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});});await platform.onlineCredential(employee,{purpose:'personal'},token);
    const key=(await repo.read()).keys.find(k=>k.internal)!;expect(key).toBeDefined();await expect(platform.keyDetail(operator,key.id)).rejects.toThrow('outside');await expect(platform.keyDetail(employee,key.id)).rejects.toThrow('outside');
  });
});
