import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import type { PlatformCommand } from '@ai-gateway/contracts';
import { DemoStore } from '../store/demo.store';
import { WorkspaceRepository } from './workspace.repository';
import { PlatformService } from './platform.service';
import { activeMember } from './validation';
import { futureGrantStatus,runPeriodic } from './domain';
import { AuthService } from './auth.service';
const operator='operator-demo-001',range={poolId:'pool-local-test',mode:'follow',definitionIds:[]};

describe('organization subtree changes and automatic funding',()=>{
  let store:DemoStore,repo:WorkspaceRepository,platform:PlatformService;
  const preview=(type:string,payload:Record<string,unknown>,actor=operator)=>platform.preview(actor,{type,payload,idempotencyKey:crypto.randomUUID()});
  const command=async(type:string,payload:Record<string,unknown>,actor=operator,key=crypto.randomUUID())=>{
    const c:PlatformCommand={type,payload,idempotencyKey:key},p=await platform.preview(actor,c);
    return (await platform.execute(actor,{...c,previewToken:p.previewToken})).result as any;
  };
  const org=(name:string,parentId='org-demo')=>command('save.organization',{name,parentId});
  const plan=(name:string,amount=10)=>command('save.plan',{name,amount,range,cadence:'monthly',quotaDays:30,entitlementDays:365});
  const rule=(name:string,planId:string,organizationId:string,includeChildren=true)=>command('save.rule',{name,planId,organizationId,includeChildren,tags:[]});
  const member=(name:string,organizationId:string,extra={})=>command('save.member',{name,directoryId:name,organizationId,...extra});
  beforeEach(async()=>{
    store=new DemoStore();repo=new WorkspaceRepository(store);await repo.initialize();platform=new PlatformService(repo,store);
    await repo.transact(async tx=>{tx.state.services[0].verification='passed';tx.state.pools[0].entries[0].open=true;});
  });
  afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

  it('moves all descendant audiences, pays each new plan once and stops only future old-plan periods',async()=>{
    const a=await org('原部门'),b=await org('新部门'),child=await org('团队',a.id),leaf=await org('三级小组',child.id);
    const old=await plan('原月度'),next=await plan('新月度',7);await rule('原规则',old.id,a.id);await rule('新规则一',next.id,b.id);await rule('新规则二',next.id,b.id);
    const one=await member('直属',child.id),two=await member('下级',leaf.id),off=await member('停用',leaf.id,{active:false});
    const before=await repo.view(),payload={...child,parentId:b.id};
    const p=await preview('save.organization',payload),impact=p.impact as any;
    expect(impact.organizationChange.organizations.map((o:any)=>o.id)).toEqual(expect.arrayContaining([child.id,leaf.id]));
    expect(impact.organizationChange.members).toHaveLength(3);expect(impact.totalAmount).toBe(14);expect(impact.stoppedFutureGrants).toHaveLength(2);
    expect(impact.automaticGrants.find((r:any)=>r.memberId===off.id).status).toBe('skipped');expect(await repo.view()).toEqual(before);
    const key=crypto.randomUUID();await command('save.organization',payload,operator,key);await command('save.organization',payload,operator,key);
    let after=await repo.view();expect(after.batches.filter(v=>[one.id,two.id].includes(v.sourceId))).toHaveLength(4);
    for(const batch of before.batches)expect(after.batches.find(v=>v.id===batch.id)).toEqual(batch);
    const oldRights=after.state.entitlements.filter(e=>e.planId===old.id);expect(oldRights.every(e=>futureGrantStatus(after.state,e)==='rule_not_matching')).toBe(true);
    expect(after.state.audit.filter(a=>a.action==='automatic.match'&&a.detail.trigger==='organization.changed'&&a.detail.status==='granted')).toHaveLength(2);
    vi.useFakeTimers();vi.setSystemTime(Date.now()+32*86400000);await repo.transact(runPeriodic);after=await repo.view();
    expect(after.batches.filter(v=>oldRights.some(e=>e.id===v.entitlementId))).toHaveLength(2);
    expect(after.batches.filter(v=>after.state.entitlements.some(e=>e.id===v.entitlementId&&e.planId===next.id))).toHaveLength(4);
  });

  it('disables descendant sessions and employee keys, preserves independent applications, and restores without paying twice',async()=>{
    const parent=await org('可停用部门'),leaf=await org('下级',parent.id),p=await plan('月度');await rule('开通',p.id,parent.id);
    const person=await member('负责人',leaf.id,{password:'local-test-password-only'}),disabled=await member('已停用',leaf.id,{active:false}),key=await command('key.issue',{purpose:'personal',name:'个人密钥'},person.id);
    const auth=new AuthService(repo),session=await auth.login({directoryId:'负责人',password:'local-test-password-only'},'127.0.0.1');
    const app=await command('save.application',{billingMode:'quota',name:'独立应用',ownerId:person.id,organizationId:leaf.id,range});await command('application.fund',{applicationId:app.id,amount:5,expiresAt:new Date(Date.now()+86400000).toISOString()});
    const appKey=await command('key.issue',{purpose:'application',applicationId:app.id,name:'应用密钥'},person.id),before=await repo.view();
    const impact=(await preview('save.organization',{...parent,active:false})).impact as any;
    expect(impact.organizationChange.members.filter((m:any)=>m.beforeAccess&&!m.afterAccess).map((m:any)=>m.id)).toEqual([person.id]);
    expect(impact.organizationChange.applications[0].id).toBe(app.id);expect(impact.stoppedFutureGrants).toHaveLength(1);
    await command('save.organization',{...parent,active:false});let s=await repo.read();expect(()=>activeMember(s,person.id)).toThrow('organization');
    await expect(auth.authenticate(session.token)).rejects.toThrow('organization');
    expect(await store.getDemoCredential(key.secret)).toBeNull();expect(await store.getDemoCredential(appKey.secret)).not.toBeNull();
    expect(s.organizations.find(o=>o.id===leaf.id)?.active).toBe(true);expect((await repo.view()).batches).toEqual(before.batches);
    const restore=(await preview('save.organization',{...parent,active:true})).impact as any;expect(restore.resumedFutureGrants).toHaveLength(1);expect(restore.totalAmount).toBe(0);
    await command('save.organization',{...parent,active:true});s=await repo.read();expect(activeMember(s,person.id).id).toBe(person.id);
    expect((await auth.authenticate(session.token)).id).toBe(person.id);
    expect(s.members.find(m=>m.id===disabled.id)?.active).toBe(false);expect(await store.getDemoCredential(key.secret)).not.toBeNull();expect((await repo.view()).batches).toEqual(before.batches);
  });

  it('does not apply future-only rules on a name edit or include unrelated branches in a move',async()=>{
    const parent=await org('父部门'),child=await org('团队',parent.id),outside=await org('其他部门'),one=await member('成员',child.id);await member('无关',outside.id);
    const p=await plan('仅未来规则');await rule('尚未应用',p.id,parent.id);
    const impact=(await preview('save.organization',{...parent,name:'父部门更名'})).impact as any;
    expect(impact.organizationChange.rematches).toBe(false);expect(impact.automaticGrants).toEqual([]);
    await command('save.organization',{...parent,name:'父部门更名'});expect((await repo.read()).entitlements.some(e=>e.memberId===one.id)).toBe(false);
    const moved=(await preview('save.organization',{...child,parentId:outside.id})).impact as any;expect(moved.organizationChange.members.map((m:any)=>m.id)).toEqual([one.id]);
  });

  it('rejects cycles, unsafe root changes, missing parents, and lockout during preview and execution',async()=>{
    const parent=await org('父'),child=await org('子',parent.id);
    for(const payload of [{...parent,parentId:child.id},{...parent,parentId:'missing'},{id:'org-demo',name:'根',active:false},{id:'org-demo',name:'根',parentId:parent.id}]){
      await expect(preview('save.organization',payload)).rejects.toThrow();
      await expect(platform.execute(operator,{type:'save.organization',payload,idempotencyKey:crypto.randomUUID()})).rejects.toThrow();
    }
    const admin=(await repo.read()).members.find(m=>m.id===operator)!;await command('save.member',{...admin,organizationId:child.id});
    await expect(preview('save.organization',{...parent,active:false})).rejects.toThrow('every operator');
    await expect(preview('save.organization',{...parent},'employee-demo-001')).rejects.toThrow('operator');
    expect((await repo.read()).organizations.find(o=>o.id===parent.id)?.active).toBe(true);
  });

  it('rolls back the move, rights and audit together if automatic funding fails; stale previews cannot write',async()=>{
    const a=await org('原'),b=await org('新'),child=await org('团队',a.id);await member('成员',child.id);const p=await plan('新方案');await rule('新规则',p.id,b.id);
    const payload={...child,parentId:b.id},c:PlatformCommand={type:'save.organization',payload,idempotencyKey:crypto.randomUUID()},previewed=await platform.preview(operator,c),before=await repo.view();
    const original=repo.transact.bind(repo);vi.spyOn(repo,'transact').mockImplementation((work,options)=>original(tx=>work({...tx,grant:async()=>{throw new Error('funding unavailable');}}),options));
    await expect(platform.execute(operator,{...c,previewToken:previewed.previewToken})).rejects.toThrow('funding unavailable');expect(await repo.view()).toEqual(before);vi.restoreAllMocks();
    await member('并发新成员',child.id);await expect(platform.execute(operator,{...c,previewToken:previewed.previewToken})).rejects.toThrow('stale');
    expect((await repo.read()).organizations.find(o=>o.id===child.id)?.parentId).toBe(a.id);
  });
});
