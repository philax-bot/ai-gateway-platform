import {beforeEach,describe,expect,it} from 'vitest';
import {hasPermission,type PlatformCommand,type Role} from '@ai-gateway/contracts';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {PlatformService} from './platform.service';
import {billingView} from './billing-visibility';

const admin='operator-demo-001';
describe('composable operations responsibilities',()=>{
  let repository:WorkspaceRepository,platform:PlatformService;
  const command=(type:string,payload:Record<string,unknown>):PlatformCommand=>({type,payload,idempotencyKey:crypto.randomUUID()});
  async function execute(actorId:string,input:PlatformCommand){
    const preview=await platform.preview(actorId,input);
    return platform.execute(actorId,{...input,previewToken:preview.previewToken});
  }
  async function member(role:Role){
    const result=await execute(admin,command('save.member',{directoryId:role,name:role,organizationId:'org-demo',roles:[role]}));
    return (result.result as {id:string}).id;
  }
  beforeEach(async()=>{
    const store=new DemoStore();repository=new WorkspaceRepository(store);await repository.initialize();
    platform=new PlatformService(repository,store);
  });

  it('allows technical updates without changing prices or exposing costs',async()=>{
    const actor=await member('model_operator');
    const state=await repository.read(),service=state.services[0];
    await execute(actor,command('save.service',{...service,name:'技术配置',mappings:service.mappings.map(({definitionId,upstreamModel,limits})=>({definitionId,upstreamModel,limits}))}));
    expect((await repository.read()).services[0].mappings[0]).toMatchObject(service.mappings[0]);
    await expect(platform.preview(actor,command('save.service',{...service,mappings:service.mappings.map(m=>({...m,inputPrice:123}))}))).rejects.toMatchObject({status:403});
    await expect(platform.preview(actor,command('pricing.update',{definitionId:state.definitions[0].id,billingMultiplier:3}))).rejects.toMatchObject({status:403});
    const snapshot=billingView(await platform.snapshot(actor),false,true);
    expect(snapshot.services[0].baseUrl).toBe(service.baseUrl);
    expect(snapshot.services[0].mappings[0].costPrice).toBeUndefined();
    expect(snapshot.definitions[0].billingMultiplier).toBeUndefined();
  });

  it('lets finance change prices through a separate command while retaining technical configuration',async()=>{
    const actor=await member('finance_operator');
    const state=await repository.read(),service=state.services[0];
    await execute(actor,command('pricing.update',{serviceId:service.id,mappings:[{definitionId:service.mappings[0].definitionId,inputPrice:2,outputPrice:3,cachedInputPrice:1}]}));
    const current=(await repository.read()).services[0];
    expect(current.baseUrl).toBe(service.baseUrl);expect(current.configVersion).toBe(service.configVersion);
    expect(current.mappings[0].inputPrice).toBe(2);
    await expect(platform.preview(actor,command('save.service',{...service,baseUrl:'https://elsewhere.example'}))).rejects.toMatchObject({status:403});
    await expect(platform.verifyService(actor,service.id,{})).rejects.toMatchObject({status:403});
  });

  it('keeps audit read-only and denies privilege escalation and stale authorized replays',async()=>{
    const auditor=await member('auditor'),technical=await member('model_operator');
    const state=await repository.read(),input=command('save.provider',{name:'test',adapter:'openai',kinds:['chat'],active:true});
    await expect(platform.preview(auditor,input)).rejects.toMatchObject({status:403});
    await expect(platform.preview(technical,command('save.member',{id:technical,roles:['operator']}))).rejects.toMatchObject({status:403});
    const update=command('save.definition',{...state.definitions[0],name:'技术更新',billingMultiplier:undefined});
    await execute(technical,update);
    await repository.transact(async tx=>{tx.state.members.find(m=>m.id===technical)!.roles=['auditor'];});
    await expect(platform.execute(technical,update)).rejects.toMatchObject({status:403});
    expect((await platform.queryAudit(auditor,{})).items.length).toBeGreaterThan(0);
  });

  it('combines responsibilities and rejects unknown role names',()=>{
    expect(hasPermission({roles:['model_operator','finance_operator']},'pricing.write')).toBe(true);
    expect(hasPermission({roles:['model_operator','finance_operator']},'models.write')).toBe(true);
    expect(hasPermission({roles:['auditor']},'models.write')).toBe(false);
    expect(hasPermission({roles:['constructor']},'administration.manage')).toBe(false);
  });
});
