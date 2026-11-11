import {beforeEach,describe,expect,it} from 'vitest';
import type {ModelDefinition,PlatformCommand} from '@ai-gateway/contracts';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {PlatformService} from './platform.service';

const operator='operator-demo-001',employee='employee-demo-001';
describe('model discovery metadata and authorized projection',()=>{
  let repository:WorkspaceRepository,platform:PlatformService;
  beforeEach(async()=>{const store=new DemoStore();repository=new WorkspaceRepository(store);await repository.initialize();platform=new PlatformService(repository,store);});
  async function command(type:string,payload:Record<string,unknown>,actor=operator){
    const input:PlatformCommand={type,payload,idempotencyKey:crypto.randomUUID()},preview=await platform.preview(actor,input);
    return (await platform.execute(actor,{...input,previewToken:preview.previewToken})).result;
  }
  const base={name:'模型资料',modelId:'discovery-unit',contextTokens:32768,active:true};
  const save=async(payload:Record<string,unknown>,actor=operator)=>await command('save.definition',payload,actor) as ModelDefinition;
  async function grant(){
    await repository.transact(async tx=>{tx.state.services[0].verification='passed';tx.state.pools[0].entries[0].open=true;});
    const range={poolId:'pool-local-test',mode:'follow',definitionIds:[]};
    const plan=await command('save.plan',{name:'资料测试方案',range,amount:10,cadence:'once',quotaDays:30,entitlementDays:30}) as {id:string};
    await command('distribution.execute',{operation:'open_plan',planId:plan.id,memberIds:[employee]});
  }
  it('saves discovery fields, preserves old client edits, clears explicitly, and keeps admission settings separate',async()=>{
    const created=await save({...base,vendor:'资料厂商',capabilities:['text','vision','text'],maxOutputTokens:8192});
    expect(created.capabilities).toEqual(['text','vision']);
    const edited=await save({...base,id:created.id,name:'旧客户端编辑'});
    expect(edited).toMatchObject({vendor:'资料厂商',capabilities:['text','vision'],maxOutputTokens:8192,contextTokens:32768});
    const cleared=await save({...base,id:created.id,vendor:'',capabilities:[],maxOutputTokens:null});
    expect(cleared.vendor).toBeUndefined();expect(cleared.capabilities).toEqual([]);expect(cleared.maxOutputTokens).toBeUndefined();
    const state=await repository.read();
    expect(state.definitions.find(d=>d.id===created.id)?.contextTokens).toBe(32768);
    expect(state.settings.limits.maxOutputTokens).toBe(4096);
    expect(state.audit.some(a=>a.action==='save.definition')).toBe(true);
  });
  it('rejects invalid metadata without mutation and denies non-operator writes',async()=>{
    const created=await save(base),before=await repository.read();
    for(const maxOutputTokens of [0,-1,1.5,32769,'8192',true,{},NaN,Infinity])await expect(save({...base,id:created.id,maxOutputTokens})).rejects.toThrow('maxOutputTokens');
    for(const capabilities of [['audio'],['__proto__'],['constructor'],'text',[1],null])await expect(save({...base,id:created.id,capabilities})).rejects.toThrow('capabilities');
    for(const vendor of [42,{},'x'.repeat(101)])await expect(save({...base,id:created.id,vendor})).rejects.toThrow('vendor');
    await expect(save({...base,id:created.id,vendor:'越权修改'},employee)).rejects.toMatchObject({status:403});
    expect((await repository.read()).definitions).toEqual(before.definitions);
  });
  it('retains only authorized discovery models during source outages without changing operational balances',async()=>{
    await grant();
    await save({...base,modelId:'ungranted-model',vendor:'不可见厂商'});
    const ready=await platform.snapshot(employee);
    expect(ready.purposes[0].models[0].status).toBe('ready');
    await repository.transact(async tx=>{tx.state.services[0].active=false;});
    const unavailable=await platform.snapshot(employee);
    expect(unavailable.purposes[0].models).toEqual([]);
    expect(unavailable.purposes[0].availableAmount).toBe(0);
    expect(unavailable.purposes[0].catalogModels).toEqual([expect.objectContaining({modelId:'test-model',status:'model_unavailable',availableAmount:10})]);
    expect(unavailable.definitions.map(d=>d.modelId)).toEqual(['test-model']);
    expect(unavailable.services).toEqual([]);expect(unavailable.pools).toEqual([]);
    await repository.transact(async tx=>{tx.state.pools[0].entries[0].open=false;});
    const closed=await platform.snapshot(employee);
    expect(closed.purposes[0].catalogModels).toEqual([]);expect(closed.definitions).toEqual([]);
  });
  it('keeps no-quota models visible and separates project access from personal access',async()=>{
    await grant();
    const project=await command('save.project',{initialAmount:1,validity:'permanent',name:'模型范围项目',managerId:operator,range:{poolId:'pool-local-test',mode:'specific',definitionIds:['definition-test-model']}}) as {id:string};
    await command('project.members',{projectId:project.id,memberIds:[employee]});
    const snapshot=await platform.snapshot(employee),projectView=snapshot.purposes.find(p=>p.id===project.id)!;
    expect(projectView.catalogModels?.[0]).toMatchObject({modelId:'test-model',status:'no_quota',availableAmount:0});
    expect(snapshot.purposes[0].catalogModels?.[0]).toMatchObject({modelId:'test-model',status:'ready',availableAmount:10});
    await repository.transact(async tx=>{tx.state.entitlements[0].status='revoked';});
    const revoked=await platform.snapshot(employee);
    expect(revoked.purposes[0].catalogModels).toEqual([]);
    expect(revoked.purposes.find(p=>p.id===project.id)?.catalogModels).toHaveLength(1);
  });
});
