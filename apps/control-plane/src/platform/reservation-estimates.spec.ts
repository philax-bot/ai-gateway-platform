import {describe,it,expect} from 'vitest';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {PlatformService} from './platform.service';

describe('model reservation estimate configuration',()=>{
  it('validates, preserves for older clients, and clears an optional estimate without changing context',async()=>{
    const store=new DemoStore(),repository=new WorkspaceRepository(store);await repository.initialize();
    const platform=new PlatformService(repository,store);
    const save=async(payload:Record<string,unknown>)=>{
      const command={type:'save.definition',payload,idempotencyKey:crypto.randomUUID()};
      const preview=await platform.preview('operator-demo-001',command);
      return (await platform.execute('operator-demo-001',{...command,previewToken:preview.previewToken})).result as {id:string;estimatedOutputTokens?:number;contextTokens:number};
    };
    const base={name:'估算配置测试',modelId:'estimate-unit',contextTokens:1000000,active:true};
    const created=await save({...base,estimatedOutputTokens:4096});
    expect(created.estimatedOutputTokens).toBe(4096);expect(created.contextTokens).toBe(1000000);
    expect((await save({...base,id:created.id})).estimatedOutputTokens).toBe(4096);
    for(const value of [0,-1,1.5,1000001,'invalid'])await expect(save({...base,id:created.id,estimatedOutputTokens:value})).rejects.toThrow('estimatedOutputTokens');
    expect((await save({...base,id:created.id,estimatedOutputTokens:null})).estimatedOutputTokens).toBeUndefined();
    const persisted=(await repository.read()).definitions.find(d=>d.id===created.id);
    expect(persisted?.contextTokens).toBe(1000000);expect(persisted?.estimatedOutputTokens).toBeUndefined();
  });
});
