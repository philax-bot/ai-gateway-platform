import {beforeEach,describe,expect,it} from 'vitest';
import type {PlatformCommand} from '@ai-gateway/contracts';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {PlatformService} from './platform.service';

const operator='operator-demo-001',employee='employee-demo-001',range={poolId:'pool-local-test',mode:'follow',definitionIds:[]};
describe('atomic key status changes',()=>{
  let repository:WorkspaceRepository,platform:PlatformService,store:DemoStore,application:any,keys:any[];
  const input=(type:string,payload:Record<string,unknown>):PlatformCommand=>({type,payload,idempotencyKey:crypto.randomUUID()});
  async function execute(command:PlatformCommand,actor=operator){const preview=await platform.preview(actor,command);return platform.execute(actor,{...command,previewToken:preview.previewToken});}
  async function command(type:string,payload:Record<string,unknown>,actor=operator){return (await execute(input(type,payload),actor)).result as any;}
  beforeEach(async()=>{
    store=new DemoStore();repository=new WorkspaceRepository(store);await repository.initialize();platform=new PlatformService(repository,store);
    await repository.transact(async tx=>{tx.state.services[0].verification='passed';tx.state.pools[0].entries[0].open=true;});
    application=await command('save.application',{name:'批量接入应用',ownerId:employee,organizationId:'org-demo',range});
    keys=await Promise.all([1,2].map(n=>command('key.issue',{name:`工具 ${n}`,purpose:'application',applicationId:application.id},employee)));
  });
  it('previews masked objects, then changes credentials together and writes per-key history once',async()=>{
    const c=input('keys.status',{ids:keys.map(k=>k.key.id),status:'disabled',reason:'停止旧工具接入'}),preview=await platform.preview(employee,c);
    expect(preview.impact).toMatchObject({changedCount:2,skippedCount:0,keyChanges:[{name:'工具 1',before:'active',after:'disabled'},{name:'工具 2',before:'active',after:'disabled'}]});
    for(const key of keys)expect(JSON.stringify(preview)).not.toContain(key.secret);
    expect(JSON.stringify(preview)).not.toContain('keyHash');
    const result=await platform.execute(employee,{...c,previewToken:preview.previewToken});expect(result.result).toMatchObject({changedCount:2,skippedCount:0});
    for(const key of keys){expect(await store.getDemoCredential(key.secret)).toBeNull();const detail=await platform.keyDetail(employee,key.key.id);expect(detail.history.filter(h=>h.action==='key.status')).toHaveLength(1);expect(detail.history.at(-1)?.reason).toBe('停止旧工具接入');}
    await platform.execute(employee,c);for(const key of keys)expect((await platform.keyDetail(employee,key.key.id)).history.filter(h=>h.action==='key.status')).toHaveLength(1);
  });
  it('rejects a mixed inaccessible or missing list without changing allowed targets',async()=>{
    const another=await command('save.application',{name:'其他应用',ownerId:operator,organizationId:'org-demo',range}),other=await command('key.issue',{name:'其他工具',purpose:'application',applicationId:another.id});
    for(const id of [other.key.id,'key-not-found']){
      await expect(execute(input('keys.status',{ids:[keys[0].key.id,id],status:'revoked',reason:'不能部分执行'}),employee)).rejects.toMatchObject({status:id===other.key.id?403:404});
      expect((await platform.keyDetail(employee,keys[0].key.id)).key.status).toBe('active');expect(await store.getDemoCredential(keys[0].secret)).not.toBeNull();
    }
  });
  it('skips terminal and already matching keys, deduplicates targets and never reactivates in bulk',async()=>{
    await command('key.status',{id:keys[0].key.id,status:'revoked',reason:'原工具退役'},employee);
    const result=await command('keys.status',{ids:[keys[0].key.id,keys[1].key.id,keys[1].key.id],status:'disabled',reason:'停用剩余工具'},employee);
    expect(result).toMatchObject({changedCount:1,skippedCount:1});expect(result.keys).toHaveLength(2);
    expect((await platform.keyDetail(employee,keys[0].key.id)).key.status).toBe('revoked');
    expect(await command('keys.status',{ids:[keys[1].key.id],status:'disabled',reason:'状态已达成'},employee)).toMatchObject({changedCount:0,skippedCount:1});
    await expect(execute(input('keys.status',{ids:[keys[1].key.id],status:'active',reason:'不允许批量恢复'}),employee)).rejects.toMatchObject({status:400});
  });
  it('rechecks handoff before execution and before returning a previous bulk result',async()=>{
    const c=input('keys.status',{ids:keys.map(k=>k.key.id),status:'disabled',reason:'负责人操作'});await execute(c,employee);
    const retry=input('keys.status',{ids:[keys[0].key.id],status:'revoked',reason:'预览后交接'}),preview=await platform.preview(employee,retry);
    await command('save.application',{...application,ownerId:operator});
    await expect(platform.execute(employee,{...retry,previewToken:preview.previewToken})).rejects.toMatchObject({status:403});
    await expect(platform.execute(employee,c)).rejects.toMatchObject({status:403});
    expect((await platform.keyDetail(operator,keys[0].key.id)).key.status).toBe('disabled');
  });
  it('requires a current preview, a bounded nonempty list and a reason',async()=>{
    const c=input('keys.status',{ids:keys.map(k=>k.key.id),status:'revoked',reason:'核对后退役'}),preview=await platform.preview(employee,c);
    await command('settings.update',{name:'使旧预览失效'});
    await expect(platform.execute(employee,{...c,previewToken:preview.previewToken})).rejects.toMatchObject({status:409});
    for(const payload of [{ids:[]},{ids:Array.from({length:201},(_,i)=>`key-${i}`)},{ids:keys.map(k=>k.key.id),reason:''}])await expect(platform.preview(employee,input('keys.status',{status:'disabled',reason:'必填',...payload}))).rejects.toMatchObject({status:400});
    expect((await platform.keyDetail(employee,keys[0].key.id)).key.status).toBe('active');
  });
});
