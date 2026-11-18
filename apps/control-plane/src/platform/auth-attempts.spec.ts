import { beforeEach, describe, expect, it } from 'vitest';
import { DemoStore } from '../store/demo.store';
import { WorkspaceRepository } from './workspace.repository';
import { AuthService } from './auth.service';
import { passwordHash } from './validation';

const password='a-long-local-password';
describe('login attempt limiting',()=>{
  let repository:WorkspaceRepository,auth:AuthService;
  beforeEach(async()=>{
    repository=new WorkspaceRepository(new DemoStore());await repository.initialize();
    auth=new AuthService(repository);
    await auth.setup({directoryId:'admin',name:'管理员',password},'127.0.0.1');
  });
  const fail=async(ip:string,directoryId='admin')=>{await expect(auth.login({directoryId,password:'wrong-long-password'},ip)).rejects.toThrow(/invalid credentials|too many login attempts/);};
  const bucketCount=()=>(auth as unknown as {attempts:Map<string,{count:number;until:number}>}).attempts.size;
  const buckets=()=>[...(auth as unknown as {attempts:Map<string,{count:number;until:number}>}).attempts.keys()];

  it('locks one account across many sources instead of only locking the source IP',async()=>{
    for(let i=0;i<10;i++)await fail(`10.0.0.${i}`);
    // A fresh source IP would pass a per-IP-only limit; the account bucket still refuses it.
    await expect(auth.login({directoryId:'admin',password:'wrong-long-password'},'10.1.0.1')).rejects.toThrow('too many login attempts');
    await expect(auth.login({directoryId:'admin',password},'10.1.0.2')).rejects.toThrow('too many login attempts');
  });

  it('keeps one exhausted source from locking unrelated accounts',async()=>{
    await repository.transact(async tx=>{tx.state.members.push({id:'member-second',name:'第二用户',directoryId:'second',organizationId:'org-demo',category:'employee',tags:[],roles:['employee'],active:true,validUntil:null,sponsorId:null,passwordHash:passwordHash('another-long-password')});});
    for(let i=0;i<10;i++)await fail('192.0.2.10','second');
    // The exhausted source is refused for every account, as before.
    await expect(auth.login({directoryId:'admin',password},'192.0.2.10')).rejects.toThrow('too many login attempts');
    // Another account is untouched when it comes from another source.
    await expect(auth.login({directoryId:'admin',password},'192.0.2.11')).resolves.toMatchObject({member:{directoryId:'admin'}});
    // The exhausted account stays locked even from a fresh source.
    await expect(auth.login({directoryId:'second',password:'another-long-password'},'192.0.2.12')).rejects.toThrow('too many login attempts');
  });

  it('clears both buckets on a successful login and prunes expired ones',async()=>{
    await fail('198.51.100.7');
    expect(buckets()).toContain('source:198.51.100.7');
    expect(buckets()).toContain('account:admin');
    await auth.login({directoryId:'admin',password},'198.51.100.7');
    expect(buckets()).toEqual([]);
    for(let i=0;i<10;i++)await fail('198.51.100.8','admin');
    const store=(auth as unknown as {attempts:Map<string,{count:number;until:number}>}).attempts;
    for(const entry of store.values())entry.until=Date.now()-1;
    await expect(auth.login({directoryId:'admin',password},'198.51.100.9')).resolves.toMatchObject({member:{directoryId:'admin'}});
    expect(bucketCount()).toBe(0);
  });
});
