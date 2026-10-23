import {afterEach,describe,it,expect,vi} from 'vitest';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {AuthService} from './auth.service';
import {PlatformService} from './platform.service';
afterEach(()=>vi.unstubAllEnvs());
describe('production starts without demonstration subjects, money or credentials',()=>{
  it('creates one administrator only after a valid install token and keeps all fixtures absent',async()=>{
    vi.stubEnv('PLATFORM_MODE','production');vi.stubEnv('BOOTSTRAP_TOKEN','production-install-test-token-only-00001');
    const store=new DemoStore(),repo=new WorkspaceRepository(store),auth=new AuthService(repo);
    expect(store.credentials.size).toBe(0);expect(store.quotaBatches.size).toBe(0);expect((await repo.read()).members).toEqual([]);
    expect(await auth.bootstrapStatus()).toMatchObject({required:true,tokenRequired:true});
    const input={name:'安装管理员',directoryId:'install-admin',password:'local-install-test-password'};
    await expect(auth.setup(input,'127.0.0.1')).rejects.toThrow();expect((await repo.read()).members).toEqual([]);
    await auth.setup({...input,bootstrapToken:process.env.BOOTSTRAP_TOKEN},'192.0.2.1');
    const s=await repo.read();expect(s.members).toHaveLength(1);expect(s.members[0].id).not.toContain('demo');expect(s.definitions).toEqual([]);expect(s.pools).toEqual([]);expect(s.services).toEqual([]);expect(s.settings.personalDefaultPoolId).toBeNull();
    await expect(auth.setup({...input,bootstrapToken:process.env.BOOTSTRAP_TOKEN},'127.0.0.1')).rejects.toThrow('already initialized');
    const login=await auth.login(input,'127.0.0.1');expect(login.member.id).toBe(s.members[0].id);const snapshot=await new PlatformService(repo,store).snapshot(login.member.id);expect(snapshot.quotaBatches).toEqual([]);expect(snapshot.purposes[0].status).toBe('not_open');
    expect(await store.getDemoCredential('local-employee-key')).toBeNull();
  });
});
