import {describe,expect,it} from 'vitest';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {AuthService} from './auth.service';
import {hash} from './validation';

async function fixture(){
  const repo=new WorkspaceRepository(new DemoStore()),auth=new AuthService(repo),token='isolated-session-token',memberId='employee-demo-001';
  await repo.transact(async tx=>{tx.state.sessions.push({tokenHash:hash(token),memberId,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});});
  return {repo,auth,token,memberId};
}
describe('purpose-scoped workspace reads',()=>{
  it('authenticates against current roles, ancestor status and session revocation without a stale identity cache',async()=>{
    const {repo,auth,token,memberId}=await fixture();
    const member=await auth.authenticate(token);expect(member.id).toBe(memberId);
    await repo.transact(async tx=>{tx.state.members.find(m=>m.id===memberId)!.roles=['operator'];});
    expect((await auth.authenticate(token)).roles).toEqual(['operator']);
    await repo.transact(async tx=>{tx.state.organizations.find(o=>o.id===member.organizationId)!.active=false;});
    await expect(auth.authenticate(token)).rejects.toThrow('organization');
    await repo.transact(async tx=>{tx.state.organizations.find(o=>o.id===member.organizationId)!.active=true;});
    await auth.logout(token);await expect(auth.authenticate(token)).rejects.toThrow('session expired');
  });
  it('excludes unrelated history and preserves nulls, absent optional fields and detached copies',async()=>{
    const {repo}=await fixture();
    await repo.transact(async tx=>{tx.state.audit.push({id:'unrelated',actorId:'fixture',action:'history',objectId:'fixture',reason:'unrelated history',createdAt:new Date().toISOString(),detail:{text:'history-only'}});});
    const authentication=await repo.readAuthentication(),maintenance=await repo.readMaintenance();
    expect(JSON.stringify(authentication)).not.toContain('history-only');expect(JSON.stringify(maintenance)).not.toContain('history-only');
    expect(authentication.organizations.find(o=>o.parentId===null)).toBeDefined();expect(Object.hasOwn(maintenance,'retention')).toBe(false);
    authentication.members[0].active=false;maintenance.settings.retentionAutomatic=true;
    const full=await repo.read();expect(full.members[0].active).toBe(true);expect(full.settings.retentionAutomatic).not.toBe(true);expect(full.audit.at(-1)!.id).toBe('unrelated');
  });
});
