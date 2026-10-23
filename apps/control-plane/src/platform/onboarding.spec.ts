import { beforeEach,describe,it,expect,vi,afterEach } from 'vitest';
import type { PlatformCommand } from '@ai-gateway/contracts';
import { DemoStore } from '../store/demo.store';
import { WorkspaceRepository } from './workspace.repository';
import { PlatformService } from './platform.service';
import { futureGrantStatus,runPeriodic } from './domain';
const operator='operator-demo-001',employee='employee-demo-001';
describe('onboarding audience, trusted import and automatic grants',()=>{
  let repo:WorkspaceRepository,platform:PlatformService,plan:any;
  const command=async(type:string,payload:Record<string,unknown>,key=crypto.randomUUID())=>{
    const c:PlatformCommand={type,payload,idempotencyKey:key},preview=await platform.preview(operator,c);
    return (await platform.execute(operator,{...c,previewToken:preview.previewToken})).result as any;
  };
  const preview=(type:string,payload:Record<string,unknown>)=>platform.preview(operator,{type,payload,idempotencyKey:crypto.randomUUID()});
  const member=(directoryId:string,extra:Record<string,unknown>={})=>({directoryId,name:directoryId,organizationId:'department-engineering',category:'employee',tags:['AI 编码'],...extra});
  const rule=(name:string,planId=plan.id,extra:Record<string,unknown>={})=>command('save.rule',{name,planId,organizationId:'department-engineering',includeChildren:true,category:'employee',tags:['AI 编码'],...extra});
  beforeEach(async()=>{
    const store=new DemoStore();repo=new WorkspaceRepository(store);await repo.initialize();platform=new PlatformService(repo,store);
    await repo.transact(async tx=>{tx.state.services[0].verification='passed';tx.state.pools[0].entries[0].open=true;});
    plan=await command('save.plan',{name:'研发月度',range:{poolId:'pool-local-test',mode:'follow',definitionIds:[]},amount:10,cadence:'monthly',quotaDays:30,entitlementDays:365});
  });
  afterEach(()=>vi.useRealTimers());
  it('keeps saved rules future-only, groups matching same-plan rules and stacks distinct plans',async()=>{
    const one=await rule('规则一'),two=await rule('规则二');
    expect((await repo.read()).entitlements.filter(e=>e.planId===plan.id)).toHaveLength(0);
    const another=await command('save.plan',{...plan,id:undefined,name:'叠加方案',amount:7});await rule('叠加',another.id);
    const p=await preview('save.member',member('new-user'));expect(p.impact.totalAmount).toBe(17);
    expect((p.impact.automaticGrants as any[]).find(r=>r.planId===plan.id).ruleIds).toEqual([one.id,two.id]);
    const saved=await command('save.member',member('new-user'));
    const before=await repo.view();expect(before.state.entitlements.filter(e=>e.memberId===saved.id)).toHaveLength(2);
    expect(before.batches.filter(b=>b.sourceId===saved.id).reduce((n,b)=>n+b.totalAmount,0)).toBe(17);
    await command('save.member',{...member('new-user'),id:saved.id});await command('auto.apply',{id:one.id});await command('auto.apply',{id:two.id});
    expect((await repo.view()).batches.filter(b=>b.sourceId===saved.id)).toHaveLength(2);
    const audit=(await repo.read()).audit.filter(a=>a.action==='automatic.match'&&a.objectId===saved.id);
    expect(audit.length).toBeGreaterThan(2);expect(audit[0].detail).toMatchObject({trigger:'member.saved',planVersion:1,conditions:expect.any(Array)});
  });
  it('records excluded and disabled-plan matches; a repaired retry funds once',async()=>{
    const r=await rule('研发');
    const inactive=await command('save.member',member('inactive',{active:false}));
    const expired=await command('save.member',member('expired',{validUntil:new Date(Date.now()-1000).toISOString()}));
    await command('save.plan',{...plan,active:false});const failed=await command('save.member',member('failed-plan'));
    const state=await repo.read();expect(state.distributions.flatMap(d=>d.results).filter(r=>[inactive.id,expired.id].includes(r.memberId)).every(r=>r.status==='skipped')).toBe(true);
    expect(state.audit.find(a=>a.action==='automatic.match'&&a.objectId===failed.id)?.detail).toMatchObject({status:'failed',reason:'方案已停用'});
    expect((await repo.view()).batches.filter(b=>b.sourceId===failed.id)).toHaveLength(0);
    await command('save.plan',{...plan,active:true});await command('auto.apply',{id:r.id});await command('auto.apply',{id:r.id});
    expect((await repo.view()).batches.filter(b=>b.sourceId===failed.id)).toHaveLength(1);
    expect((await repo.read()).members.find(m=>m.id===inactive.id)!.active).toBe(false);
  });
  it('deduplicates imports by stable directory ID and rejects unsafe or duplicate rows atomically',async()=>{
    await rule('导入匹配');const rows=[member('import-a'),member('import-b')];const result=await command('import.members',{rows});
    const before=await repo.view();await command('import.members',{rows:rows.map(r=>({...r,name:'更新姓名'}))});
    const after=await repo.view();expect(after.batches).toHaveLength(before.batches.length);
    expect(after.state.members.filter(m=>m.directoryId.startsWith('import-')).map(m=>m.id)).toEqual(result.members.map((m:any)=>m.id));
    expect(after.state.members.find(m=>m.directoryId==='import-a')?.passwordHash).toBeUndefined();
    for(const input of [[member('duplicate'),member('duplicate')],[member('valid'),member('unsafe',{roles:['operator']})],[member('valid'),member('unsafe',{password:'must-not-import'})]]){
      await expect(command('import.members',{rows:input})).rejects.toThrow();
      expect((await repo.read()).members.some(m=>m.directoryId==='valid'||m.directoryId==='duplicate')).toBe(false);
    }
    const p=await preview('save.member',member('with-pass',{password:'a-valid-long-password'}));expect(JSON.stringify(p)).not.toContain('a-valid-long-password');
    await expect(command('save.member',{...member('operator'),id:operator,active:false})).rejects.toThrow('operator');
  });
  it('freezes AND-scoped lists, excludes inactive people and only tops up existing rights',async()=>{
    await command('save.organization',{id:undefined,name:'研发子组',parentId:'department-engineering'});
    const child=(await repo.read()).organizations.find(o=>o.name==='研发子组')!.id;
    const included=await command('save.member',member('child',{organizationId:child}));
    await command('save.member',member('off',{active:false}));await command('save.member',member('other-tag',{tags:[]}));
    const payload={operation:'open_plan',planId:plan.id,scope:'conditions',organizationId:'department-engineering',includeChildren:true,category:'employee',tags:['AI 编码']};
    const p=await preview('distribution.execute',payload);expect(p.impact.grantCount).toBe(2);expect(p.impact.excludedCount).toBe(1);expect(p.impact.totalAmount).toBe(20);
    await command('distribution.execute',payload);const state=await repo.read(),e=state.entitlements.find(e=>e.memberId===included.id)!;
    const topup={operation:'topup',sourcePlanId:plan.id,scope:'all',amount:3,expiresAt:new Date(Date.now()+86400000).toISOString()};
    const t=await preview('distribution.execute',topup);expect(t.impact.grantCount).toBe(2);expect(t.impact.totalAmount).toBe(6);
    const key=crypto.randomUUID();const count=(await repo.view()).batches.length;await command('distribution.execute',topup,key);await command('distribution.execute',topup,key);
    expect((await repo.view()).batches).toHaveLength(count+2);
    const beyond=await preview('distribution.execute',{...topup,memberIds:[included.id],expiresAt:new Date(Date.parse(e.expiresAt)+86400000).toISOString()});expect(beyond.impact.grantCount).toBe(0);
    await expect(preview('distribution.execute',{planId:plan.id})).rejects.toThrow('explicit');
    const stale:PlatformCommand={type:'distribution.execute',payload:topup,idempotencyKey:crypto.randomUUID()};const signed=await platform.preview(operator,stale);
    await command('save.member',member('after-preview'));await expect(platform.execute(operator,{...stale,previewToken:signed.previewToken})).rejects.toThrow('stale');
  });
  it('stops future automatic grants when conditions or plan links change, preserving issued batches',async()=>{
    const r=await rule('规则'),saved=await command('save.member',member('changing'));let s=await repo.read(),e=s.entitlements.find(e=>e.memberId===saved.id)!;
    const batch=(await repo.view()).batches.find(b=>b.entitlementId===e.id)!;
    await command('save.member',{...member('changing'),id:saved.id,tags:[]});s=await repo.read();expect(futureGrantStatus(s,e)).toBe('rule_not_matching');
    expect((await repo.view()).batches.find(b=>b.id===batch.id)?.expiresAt).toBe(batch.expiresAt);
    await command('save.member',{...member('changing'),id:saved.id});
    const other=await command('save.plan',{...plan,id:undefined,name:'更换方案'});await command('save.rule',{...r,planId:other.id});s=await repo.read();expect(futureGrantStatus(s,e)).toBe('rule_not_matching');
    vi.useFakeTimers();vi.setSystemTime(Date.now()+32*86400000);await repo.transact(async tx=>{await runPeriodic(tx);});
    expect((await repo.view()).batches.filter(b=>b.entitlementId===e.id)).toHaveLength(1);
  });
  it('does not pay a second monthly cycle when an entitlement is revoked and reopened',async()=>{
    await command('distribution.execute',{planId:plan.id,memberIds:[employee]});const e=(await repo.read()).entitlements.find(e=>e.planId===plan.id)!;
    await command('entitlement.revoke',{id:e.id,reason:'测试重开'});
    const p=await preview('distribution.execute',{planId:plan.id,memberIds:[employee]});expect(p.impact.totalAmount).toBe(0);
    const before=(await repo.view()).batches.length;await command('distribution.execute',{planId:plan.id,memberIds:[employee]});expect((await repo.view()).batches).toHaveLength(before);
    vi.useFakeTimers();vi.setSystemTime(Date.now()+32*86400000);await repo.transact(async tx=>{await runPeriodic(tx);});expect((await repo.view()).batches).toHaveLength(before+1);
    await repo.transact(async tx=>{await runPeriodic(tx);});expect((await repo.view()).batches).toHaveLength(before+1);
  });
});
