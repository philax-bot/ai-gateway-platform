import { beforeEach,describe,it,expect,vi } from 'vitest';
import type { PlatformCommand } from '@ai-gateway/contracts';
import { DemoStore } from '../store/demo.store';
import { WorkspaceRepository } from './workspace.repository';
import { PlatformService } from './platform.service';
const operator='operator-demo-001',employee='employee-demo-001',range={poolId:'pool-local-test',mode:'follow',definitionIds:[]};
describe('application setup guidance follows scoped authoritative resources',()=>{
  let repo:WorkspaceRepository,platform:PlatformService,app:any;
  async function command(type:string,payload:Record<string,unknown>,actor=operator){const c:PlatformCommand={type,payload,idempotencyKey:crypto.randomUUID()},p=await platform.preview(actor,c);return (await platform.execute(actor,{...c,previewToken:p.previewToken})).result as any;}
  beforeEach(async()=>{const store=new DemoStore();repo=new WorkspaceRepository(store);await repo.initialize();platform=new PlatformService(repo,store);await repo.transact(async tx=>{tx.state.services[0].verification='passed';tx.state.services[0].mappings[0].outputPrice=3;tx.state.pools[0].entries[0].open=true;});app=await command('save.application',{name:'工作流助手',ownerId:employee,organizationId:'org-demo',range});});
  it('provides application models without requiring personal entitlement and distinguishes missing quota from a key',async()=>{
    expect((await platform.snapshot(employee)).purposes[0].status).toBe('not_open');
    const empty=await platform.applicationDetail(employee,app.id);expect(empty.models[0]).toMatchObject({modelId:'test-model',status:'no_quota'});expect(empty.status).toBe('no_quota');expect(empty.keys).toHaveLength(0);
    await command('application.fund',{applicationId:app.id,amount:5,expiresAt:new Date(Date.now()+86400000).toISOString()});
    const funded=await platform.applicationDetail(employee,app.id);expect(funded.status).toBe('ready');expect(funded.availableAmount).toBe(5);expect(funded.keys).toHaveLength(0);
    const issued=await command('key.issue',{name:'工作流接入',purpose:'application',applicationId:app.id},employee),detail=await platform.applicationDetail(employee,app.id);
    expect(detail.keys[0].masked).toBe(issued.key.masked);expect(detail.history.some(a=>a.action==='key.issue')).toBe(true);expect(detail.calls.summary.ended).toBe(0);expect(JSON.stringify(detail)).not.toContain(issued.secret);expect(JSON.stringify(detail)).not.toContain('keyHash');
  });
  it('gives model/price blockers before requesting funds, excludes expired money and respects disablement',async()=>{
    await repo.transact(async tx=>{tx.state.services[0].mappings[0].outputPrice=null;});expect((await platform.applicationDetail(employee,app.id)).status).toBe('price_unconfigured');
    await repo.transact(async tx=>{tx.state.services[0].mappings[0].outputPrice=3;tx.state.services[0].active=false;});expect((await platform.applicationDetail(employee,app.id)).status).toBe('model_unavailable');
    await repo.transact(async tx=>{tx.state.services[0].active=true;});const batch=await command('application.fund',{applicationId:app.id,amount:5,expiresAt:new Date(Date.now()+86400000).toISOString()});
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse(batch.expiresAt)+1);
    try{expect((await platform.applicationDetail(employee,app.id)).status).toBe('no_quota');expect((await platform.applicationDetail(employee,app.id)).availableAmount).toBe(0);}finally{clock.mockRestore();}
    await command('save.application',{...app,active:false});expect((await platform.applicationDetail(employee,app.id)).status).toBe('disabled');
  });
  it('moves visibility with ownership and keeps application money independent of personal state',async()=>{
    const next=await command('save.member',{directoryId:'app-next',name:'新负责人',organizationId:'org-demo'}),other=await command('save.member',{directoryId:'app-other',name:'无关员工',organizationId:'org-demo'});
    await expect(platform.applicationDetail(other.id,app.id)).rejects.toThrow();await command('save.application',{...app,ownerId:next.id});await expect(platform.applicationDetail(employee,app.id)).rejects.toThrow();expect((await platform.applicationDetail(next.id,app.id)).ownerName).toBe('新负责人');
    await command('save.member',{id:employee,name:'停用原负责人',directoryId:'employee',organizationId:'department-engineering',active:false});expect((await platform.applicationDetail(operator,app.id)).application.active).toBe(true);
  });
});
