import {describe,expect,it} from 'vitest';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';

describe('runtime-only workspace transactions',()=>{
  it('updates runtime records without changing business revision',async()=>{
    const store=new DemoStore(),repo=new WorkspaceRepository(store),before=await repo.read();
    await repo.transact(async tx=>{tx.state.notifications.push({id:'runtime-notice',recipientId:'operator-demo-001',title:'Runtime',body:'local fixture',objectType:'alert',objectId:'fixture',createdAt:new Date().toISOString(),readAt:null});},{runtimeOnly:true});
    const after=await repo.read();expect(after.revision).toBe(before.revision);expect(after.notifications).toHaveLength(before.notifications.length+1);
  });
  it('rolls back a disguised policy change instead of bypassing the admission fence',async()=>{
    const store=new DemoStore(),repo=new WorkspaceRepository(store),before=await repo.read();
    await expect(repo.transact(async tx=>{tx.state.members[0].active=false;tx.state.audit.push({id:'bad-change',actorId:'fixture',action:'fixture',objectId:'fixture',reason:'fixture',createdAt:new Date().toISOString(),detail:{}});},{runtimeOnly:true})).rejects.toThrow('cannot change admission policy');
    expect(await repo.read()).toEqual(before);
  });
  it('refuses credential and fund mutations even when the callback keeps the policy payload unchanged',async()=>{
    const store=new DemoStore(),repo=new WorkspaceRepository(store),funds=structuredClone([...store.quotaBatches]),credentials=structuredClone([...store.credentials]);
    await expect(repo.transact(tx=>tx.disableCredentials('employee-demo-001'),{runtimeOnly:true})).rejects.toThrow('cannot change funds or credentials');
    await expect(repo.transact(tx=>tx.updateBatchModels('personal-batch-demo-001',[]),{runtimeOnly:true})).rejects.toThrow('cannot change funds or credentials');
    expect([...store.quotaBatches]).toEqual(funds);expect([...store.credentials]).toEqual(credentials);
  });
});
