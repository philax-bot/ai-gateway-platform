import {beforeEach,describe,expect,it,vi} from 'vitest';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from '../platform/workspace.repository';
import {PlatformService} from '../platform/platform.service';
import {AgentInstancesService} from './agent-instances.service';
import type {LocalOctopRuntime} from './local-octop.runtime';

const operator='operator-demo-001',employee='employee-demo-001';
describe('managed personal Octop lifecycle',()=>{
  let repository:WorkspaceRepository,platform:PlatformService,service:AgentInstancesService,store:DemoStore;
  let running:Set<string>,delivered:string[],runtime:any;
  const key=()=>({idempotencyKey:crypto.randomUUID()});
  beforeEach(async()=>{
    store=new DemoStore();repository=new WorkspaceRepository(store);await repository.initialize();platform=new PlatformService(repository,store);
    await repository.transact(async tx=>{tx.state.services[0].verification='passed';tx.state.pools[0].entries[0].open=true;});
    async function command(type:string,payload:Record<string,unknown>){const c={type,payload,idempotencyKey:crypto.randomUUID()},p=await platform.preview(operator,c);return (await platform.execute(operator,{...c,previewToken:p.previewToken})).result as any;}
    const plan=await command('save.plan',{name:'Agent test',range:{poolId:'pool-local-test',mode:'follow',definitionIds:[]},amount:1,cadence:'once',quotaDays:1,entitlementDays:1});await command('distribution.execute',{planId:plan.id,memberIds:[employee,operator]});
    running=new Set();delivered=[];runtime={enabled:true,assertEnabled:()=>{},observe:(id:string)=>({running:running.has(id),entryUrl:running.has(id)?'http://127.0.0.1:12345':null,agentId:'QA'}),configure:vi.fn(async(id:string,secret:string)=>{delivered.push(secret);running.add(id);}),stop:vi.fn(async(id:string)=>{running.delete(id);}),access:vi.fn(async()=>({loginUrl:'http://127.0.0.1:12345',username:'platform-user',password:'one-time-user-password'}))};
    service=new AgentInstancesService(repository,runtime as LocalOctopRuntime);
  });
  it('binds stable owner identity, delivers a new Key once and replays without duplicating it',async()=>{
    const request=key(),first=await service.change(employee,'ensure',request),replay=await service.change(employee,'ensure',request);
    expect(replay?.instance?.id).toBe(first?.instance?.id);expect(runtime.configure).toHaveBeenCalledTimes(1);
    const state=await repository.read();expect(state.agentInstances).toHaveLength(1);expect(state.keys.filter(k=>k.name==='Octop 专用')).toHaveLength(1);
    expect(JSON.stringify([state,first,replay])).not.toContain(delivered[0]);expect(JSON.stringify(first)).not.toContain('keyHash');
    expect(state.keys.find(k=>k.id===first?.instance?.key?.id)?.ownerId).toBe(employee);
  });
  it('refuses foreign instance access, paths and ownership injection; operators cannot fetch user login secrets',async()=>{
    const own=(await service.change(employee,'ensure',key()))!.instance!;
    const other=(await service.change(operator,'ensure',key()))!.instance!;
    await expect(service.get(employee,other.id)).rejects.toThrow('not found');await expect(service.change(employee,'stop',key(),other.id)).rejects.toThrow('not found');
    await expect(service.change(employee,'ensure',{...key(),ownerId:operator,home:'C:\\elsewhere'})).rejects.toThrow('only idempotencyKey');
    await expect(service.access(operator,own.id)).rejects.toThrow('not found');expect((await service.get(operator,own.id)).instance?.ownerId).toBe(employee);
  });
  it('rotation revokes only the managed Key before delivering the replacement',async()=>{
    const first=(await service.change(employee,'ensure',key()))!.instance!;
    const c={type:'key.issue',payload:{name:'external client',purpose:'personal'},idempotencyKey:crypto.randomUUID()},p=await platform.preview(employee,c);const normal=(await platform.execute(employee,{...c,previewToken:p.previewToken})).result as any;
    const next=(await service.change(employee,'rotate',key(),first.id))!.instance!;
    const state=await repository.read();expect(next.key?.id).not.toBe(first.key?.id);expect(state.keys.find(k=>k.id===first.key?.id)?.status).toBe('revoked');expect(state.keys.find(k=>k.id===normal.key.id)?.status).toBe('active');expect(next.generation).toBe(2);
  });
  it('does not advertise a usable Agent with an expired dedicated Key, and recovers on ensure',async()=>{
    const first=(await service.change(employee,'ensure',key()))!.instance!;
    await repository.transact(async tx=>{tx.state.keys.find(k=>k.id===first.key!.id)!.expiresAt=new Date(0).toISOString();});
    expect((await service.get(employee)).instance).toMatchObject({status:'failed',errorCode:'key_unavailable',entryUrl:null});
    const next=(await service.change(employee,'ensure',key()))!.instance!;expect(next.status).toBe('running');expect(next.key?.id).not.toBe(first.key?.id);
  });
  it('keeps native login export disabled unless explicitly enabled',async()=>{
    const first=(await service.change(employee,'ensure',key()))!.instance!,prior=process.env.OCTOP_LEGACY_LOGIN_ENABLED;delete process.env.OCTOP_LEGACY_LOGIN_ENABLED;
    try{await expect(service.access(employee,first.id)).rejects.toThrow('platform online Agent');expect(runtime.access).not.toHaveBeenCalled();}finally{if(prior!==undefined)process.env.OCTOP_LEGACY_LOGIN_ENABLED=prior;}
  });
  it('ambiguous delivery failure revokes the new Key and allows an explicit fresh retry',async()=>{
    runtime.configure.mockRejectedValueOnce(Error('sensitive runtime error and secret'));
    await expect(service.change(employee,'ensure',key())).rejects.toThrow('dedicated key is revoked');
    const state=await repository.read();expect(state.agentInstances?.[0].status).toBe('failed');expect(state.keys.filter(k=>k.name==='Octop 专用').every(k=>k.status==='revoked')).toBe(true);expect(JSON.stringify(state)).not.toContain('sensitive runtime error');
    expect((await service.change(employee,'ensure',key()))?.instance?.status).toBe('running');
  });
  it('stops the runtime even if failed delivery compensation cannot reach storage',async()=>{
    const first=(await service.change(employee,'ensure',key()))!.instance!,failure=Error('private database failure');
    let restore=()=>{};
    runtime.configure.mockImplementationOnce(async()=>{const storage=vi.spyOn(repository,'transact').mockRejectedValue(failure);restore=()=>storage.mockRestore();throw Error('delivery failed');});
    await expect(service.change(employee,'rotate',key(),first.id)).rejects.toThrow('revocation is pending storage recovery');
    expect(runtime.stop).toHaveBeenCalledExactlyOnceWith(first.id);expect(running.has(first.id)).toBe(false);restore();
    const pending=(await repository.read()).agentInstances![0];expect(pending.operation).toBeDefined();expect(pending.status).toBe('provisioning');
    await repository.transact(async tx=>{tx.state.agentInstances![0].operation!.expiresAt=new Date(0).toISOString();});
    const recovered=(await service.change(employee,'ensure',key()))!.instance!;expect(recovered.status).toBe('running');expect(recovered.key?.id).not.toBe(pending.keyId);
    expect((await repository.read()).keys.find(k=>k.id===pending.keyId)?.status).toBe('revoked');
  });
  it('serializes turns with lifecycle operations and ignores a released old cancellation callback',async()=>{
    const first=(await service.change(employee,'ensure',key()))!.instance!,lease=await service.beginChat(employee,first.id,first.generation);
    await expect(service.change(employee,'rotate',key(),first.id)).rejects.toThrow('in progress');
    await expect(service.change(employee,'stop',key(),first.id)).rejects.toThrow('in progress');
    await expect(service.beginChat(employee,first.id,first.generation)).rejects.toThrow('in progress');
    lease.release();const rotated=(await service.change(employee,'rotate',key(),first.id))!.instance!;
    await lease.suspend();expect(runtime.stop).not.toHaveBeenCalled();expect((await service.get(employee)).instance).toMatchObject({generation:rotated.generation,status:'running',key:{status:'active'}});
    await expect(service.beginChat(employee,first.id,first.generation)).rejects.toThrow('changed before chat');
    const current=await service.beginChat(employee,first.id,rotated.generation);current.release();
  });
  it('stops on cancellation storage failure and retains the lifecycle lock until stopping finishes',async()=>{
    const first=(await service.change(employee,'ensure',key()))!.instance!,lease=await service.beginChat(employee,first.id,first.generation);
    let stopped!:()=>void;runtime.stop.mockImplementationOnce(async(id:string)=>{await new Promise<void>(r=>stopped=r);running.delete(id);});
    const storage=vi.spyOn(repository,'transact').mockRejectedValue(Error('database unavailable'));
    const suspended=lease.suspend(),rejected=expect(suspended).rejects.toThrow('database unavailable');
    await vi.waitFor(()=>expect(runtime.stop).toHaveBeenCalledOnce());
    await expect(service.change(employee,'rotate',key(),first.id)).rejects.toThrow('in progress');
    stopped();await rejected;expect(running.has(first.id)).toBe(false);storage.mockRestore();lease.release();
    expect((await service.change(employee,'ensure',key()))!.instance!.status).toBe('running');
  });
  it('does not revoke or stop a record whose generation no longer matches the chat lease',async()=>{
    const first=(await service.change(employee,'ensure',key()))!.instance!,lease=await service.beginChat(employee,first.id,first.generation);
    await repository.transact(async tx=>{tx.state.agentInstances![0].generation++;});
    await lease.suspend();lease.release();expect(runtime.stop).not.toHaveBeenCalled();expect((await service.get(employee)).instance?.key?.status).toBe('active');
  });
  it('does not hold a workspace transaction during runtime work and rejects concurrent requests',async()=>{
    let release!:()=>void;const hold=new Promise<void>(r=>release=r);runtime.configure.mockImplementationOnce(async(id:string)=>{running.add(id);await repository.read();await repository.transact(async()=>{});await hold;});
    const first=service.change(employee,'ensure',key());await vi.waitFor(()=>expect(runtime.configure).toHaveBeenCalled());
    expect((await service.get(employee)).instance?.entryUrl).toBeNull();await expect(service.change(employee,'ensure',key())).rejects.toThrow('in progress');release();await first;
  });
  it('member suspension during delivery prevents completion and revokes the pending credential',async()=>{
    runtime.configure.mockImplementationOnce(async()=>{await repository.transact(async tx=>{tx.state.members.find(m=>m.id===employee)!.active=false;});});
    await expect(service.change(employee,'ensure',key())).rejects.toThrow('dedicated key is revoked');
    expect((await repository.read()).keys.filter(k=>k.name==='Octop 专用').every(k=>k.status==='revoked')).toBe(true);
  });
  it('stopping revokes the dedicated Key and replay does not spawn or stop again',async()=>{
    const first=(await service.change(employee,'ensure',key()))!.instance!,request=key();await service.change(employee,'stop',request,first.id);await service.change(employee,'stop',request,first.id);
    expect(runtime.stop).toHaveBeenCalledTimes(1);expect((await service.get(employee)).instance?.key?.status).toBe('revoked');expect((await service.get(employee)).instance?.status).toBe('stopped');
    expect((await service.change(employee,'ensure',key()))?.instance?.key?.id).not.toBe(first.key?.id);
  });
  it('returns user login credentials only on access reset and never persists them',async()=>{
    const prior=process.env.OCTOP_LEGACY_LOGIN_ENABLED;process.env.OCTOP_LEGACY_LOGIN_ENABLED='true';try{
    const first=(await service.change(employee,'ensure',key()))!.instance!;expect((await service.access(employee,first.id)).username).toBe('platform-user');expect(JSON.stringify(await repository.read())).not.toContain('one-time-user-password');
    }finally{if(prior===undefined)delete process.env.OCTOP_LEGACY_LOGIN_ENABLED;else process.env.OCTOP_LEGACY_LOGIN_ENABLED=prior;}
  });
  it('recovers a persisted expired operation by revoking its orphan Key before retry',async()=>{
    const first=(await service.change(employee,'ensure',key()))!.instance!;
    await repository.transact(async tx=>{const record=tx.state.agentInstances![0];record.status='provisioning';record.operation={key:'prior-operation',actorId:employee,action:'ensure',token:'lost-process',expiresAt:new Date(0).toISOString()};});
    const recovered=await service.change(employee,'ensure',key());expect(recovered?.instance?.key?.id).not.toBe(first.key?.id);expect((await repository.read()).keys.find(k=>k.id===first.key?.id)?.status).toBe('revoked');
  });
  it('idempotency conflict and a disabled runtime cannot issue additional credentials',async()=>{
    const request=key(),first=(await service.change(employee,'ensure',request))!.instance!,count=(await repository.read()).keys.length;
    await expect(service.change(employee,'rotate',request,first.id)).rejects.toThrow('conflicts');expect((await repository.read()).keys.length).toBe(count);
    runtime.assertEnabled=()=>{throw Error('disabled');};await expect(service.change(employee,'rotate',key(),first.id)).rejects.toThrow('disabled');expect((await repository.read()).keys.length).toBe(count);
  });
  it('does not claim a known-running record is stopped when its runtime is no longer observed',async()=>{
    const first=(await service.change(employee,'ensure',key()))!.instance!;running.delete(first.id);
    const view=await service.get(employee);expect(view.instance?.status).toBe('failed');expect(view.instance?.errorCode).toBe('runtime_not_observed');expect(view.instance?.entryUrl).toBeNull();
    expect((await service.change(employee,'ensure',key()))?.instance?.key?.id).not.toBe(first.key?.id);
  });
});
