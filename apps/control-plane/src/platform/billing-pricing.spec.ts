import {describe,it,expect} from 'vitest';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {PlatformService} from './platform.service';
import {billingView} from './billing-visibility';
import type {PlatformCommand} from '@ai-gateway/contracts';

async function execute(platform:PlatformService,command:PlatformCommand){
  const preview=await platform.preview('operator-demo-001',command);
  return platform.execute('operator-demo-001',{...command,previewToken:preview.previewToken});
}

describe('billing configuration and visibility',()=>{
  it('preserves omitted settings for older clients and rejects partial or invalid prices',async()=>{
    const store=new DemoStore(),repository=new WorkspaceRepository(store);await repository.initialize();const platform=new PlatformService(repository,store);
    const save=async(type:string,payload:Record<string,unknown>)=>{const command={type,payload,idempotencyKey:crypto.randomUUID()},preview=await platform.preview('operator-demo-001',command);return (await platform.execute('operator-demo-001',{...command,previewToken:preview.previewToken})).result as Record<string,unknown>;};
    const state=await repository.read(),definition=state.definitions[0],service=state.services[0];
    expect((await save('save.definition',{...definition,billingMultiplier:1.5})).billingMultiplier).toBe(1.5);
    expect((await save('save.definition',{...definition})).billingMultiplier).toBe(1.5);
    for(const billingMultiplier of [-1,101,1.1234567,'2',null])await expect(save('save.definition',{...definition,billingMultiplier})).rejects.toThrow('billingMultiplier');
    const costPrice={inputPrice:0,outputPrice:2,cachedInputPrice:0};
    await save('save.service',{...service,mappings:[{...service.mappings[0],costPrice}]});
    await save('save.service',{...service,mappings:service.mappings.map(({costPrice,...mapping})=>mapping)});
    expect((await repository.read()).services[0].mappings[0].costPrice).toEqual(costPrice);
    for(const costPrice of [{inputPrice:1},[],{inputPrice:1,outputPrice:-1,cachedInputPrice:0}])await expect(save('save.service',{...service,mappings:[{...service.mappings[0],costPrice}]})).rejects.toThrow();
    await expect(save('save.service',{...service,mappings:[{...service.mappings[0],costPrice:null}]})).rejects.toThrow('必填');
    expect((await repository.read()).services[0].mappings[0].costPrice).toEqual(costPrice);
  });
  it.each(['save.service','pricing.update'])('requires complete token costs through %s, including legacy records, and accepts free costs',async type=>{
    const store=new DemoStore(),repository=new WorkspaceRepository(store);await repository.initialize();const platform=new PlatformService(repository,store);
    await repository.transact(async tx=>{tx.state.services[0].mappings[0].costPrice=null;});
    const before=await repository.read(),service=before.services[0],mapping=service.mappings[0];
    const command=(cost:Record<string,unknown>)=>({type,payload:type==='save.service'?{...service,mappings:[{...mapping,...cost}]}:{serviceId:service.id,mappings:[{definitionId:mapping.definitionId,...cost}]},idempotencyKey:crypto.randomUUID()});
    for(const cost of [{},{costPrice:undefined},{costPrice:null},{costPrice:{inputPrice:1,outputPrice:2}}])await expect(execute(platform,command(cost))).rejects.toThrow('成本价');
    expect(await repository.read()).toEqual(before);
    const input=command({costPrice:{inputPrice:0,outputPrice:0,cachedInputPrice:0}}),preview=await platform.preview('operator-demo-001',input);
    await platform.execute('operator-demo-001',{...input,previewToken:preview.previewToken});
    expect((await repository.read()).services[0].mappings[0].costPrice).toEqual({inputPrice:0,outputPrice:0,cachedInputPrice:0});
  });
  it('requires costs for new service mappings even when billing prices are filled',async()=>{
    const store=new DemoStore(),repository=new WorkspaceRepository(store);await repository.initialize();const platform=new PlatformService(repository,store);
    const service=(await repository.read()).services[0],{costPrice,...mapping}=service.mappings[0];
    await expect(execute(platform,{type:'save.service',payload:{...service,id:undefined,mappings:[{...mapping,inputPrice:2,outputPrice:8,cachedInputPrice:0.4}]},idempotencyKey:crypto.randomUUID()})).rejects.toThrow('上游成本价为必填');
    expect((await repository.read()).services).toHaveLength(1);
  });
  it.each(['save.service','pricing.update'])('requires metered costs through %s without requiring token costs',async type=>{
    const store=new DemoStore(),repository=new WorkspaceRepository(store);await repository.initialize();const platform=new PlatformService(repository,store);
    await repository.transact(async tx=>{tx.state.definitions[0].kind='image';});
    const service=(await repository.read()).services[0],mapping=service.mappings[0];
    const command=(cost:Record<string,unknown>)=>{const mappings=[{...mapping,costPrice:null,meter:{unit:'per_image',price:0.2,estimatedUnits:1,maxUnits:10,...cost}}];return {type,payload:type==='save.service'?{...service,mappings}:{serviceId:service.id,mappings},idempotencyKey:crypto.randomUUID()};};
    for(const cost of [{},{costPrice:undefined},{costPrice:null}])await expect(execute(platform,command(cost))).rejects.toThrow('单位上游成本为必填');
    for(const costPrice of [-1,NaN,Infinity,'0'])await expect(execute(platform,command({costPrice}))).rejects.toThrow();
    const input=command({costPrice:0}),preview=await platform.preview('operator-demo-001',input);
    await platform.execute('operator-demo-001',{...input,previewToken:preview.previewToken});
    expect((await repository.read()).services[0].mappings[0]).toMatchObject({costPrice:null,meter:{costPrice:0,unit:'per_image'}});
  });
  it('strips cost, multiplier and calculation basis recursively at every response boundary',()=>{
    const response={definitions:[{billingMultiplier:1.5,name:'model'}],calls:{items:[{admission:{costPrice:{inputPrice:2},price:{inputPrice:3,billing:{base:{inputPrice:2},multiplier:1.5}}}}]},totals:{confirmedAmount:3,cost:{knownAmount:2}}};
    const publicResponse=billingView(response,false);
    expect(JSON.stringify(publicResponse)).not.toMatch(/cost|billing|multiplier/);
    expect(publicResponse.calls.items[0].admission.price.inputPrice).toBe(3);
    expect(billingView(response,true)).toBe(response);
  });
});
