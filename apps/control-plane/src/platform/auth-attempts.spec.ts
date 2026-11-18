import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoStore } from '../store/demo.store';
import { WorkspaceRepository } from './workspace.repository';
import { AuthService } from './auth.service';
import { passwordHash } from './validation';

const password = 'a-long-local-password';
const source = '192.0.2.10';

describe('login attempt limiting', () => {
  let repository: WorkspaceRepository;
  let auth: AuthService;

  beforeEach(async () => {
    vi.useFakeTimers({toFake: ['Date', 'setInterval', 'clearInterval']});
    repository = new WorkspaceRepository(new DemoStore());
    await repository.initialize();
    auth = new AuthService(repository);
    await auth.setup({directoryId:'admin', name:'管理员', password}, '127.0.0.1');
  });

  afterEach(() => {
    auth.onModuleDestroy();
    vi.useRealTimers();
  });

  const login = (ip: string, directoryId = 'admin') => auth.login({directoryId, password}, ip);
  const fail = async (ip: string, directoryId = 'admin') => {
    await expect(auth.login({directoryId, password:'wrong-local-password'}, ip)).rejects.toThrow('invalid credentials');
  };
  const buckets = () => (auth as unknown as {attempts: Map<string, {failed: number[]; pending: number}>}).attempts;

  it('limits an account across sources and permits login after the window ends', async () => {
    for (let i=0; i<10; i++) await fail('198.51.100.'+i);
    await expect(login(source)).rejects.toThrow('too many login attempts');
    vi.advanceTimersByTime(15 * 60_000);
    expect(buckets().size).toBe(0);
    await expect(login(source)).resolves.toMatchObject({member:{directoryId:'admin'}});
  });

  it('keeps an unrelated account usable at a shared source and preserves source failures on success', async () => {
    for (let i=0; i<10; i++) await fail(source, 'unrelated');
    await expect(login(source)).resolves.toMatchObject({member:{directoryId:'admin'}});
    expect(buckets().get('source:'+source)?.failed).toHaveLength(10);
    for (let i=10; i<60; i++) await fail(source, 'other-directory-'+i);
    await expect(login(source)).rejects.toThrow('too many login attempts');
    await expect(login('192.0.2.11')).resolves.toMatchObject({member:{directoryId:'admin'}});
  });

  it('uses the same case-sensitive directory ID as authentication', async () => {
    await repository.transact(async tx => {
      tx.state.members.push({...tx.state.members.find(member => member.directoryId === 'admin')!,
        id:'member-capitalized', directoryId:'Admin', roles:['employee'], passwordHash:passwordHash(password)});
    });
    for (let i=0; i<10; i++) await fail(source);
    await expect(login(source, 'Admin')).resolves.toMatchObject({member:{directoryId:'Admin'}});
    await expect(login(source)).rejects.toThrow('too many login attempts');
  });

  it('clears older account failures on success and keeps newer concurrent failures', async () => {
    await fail(source);
    let signalCommitted!: () => void, allowReturn!: () => void;
    const committed = new Promise<void>(resolve => { signalCommitted = resolve; });
    const finish = new Promise<void>(resolve => { allowReturn = resolve; });
    const transact = repository.transact.bind(repository);
    vi.spyOn(repository, 'transact').mockImplementationOnce(async (work, options) => {
      const result = await transact(work, options);
      signalCommitted();
      await finish;
      return result;
    });
    const success = login(source);
    await committed;
    try {
      await fail('192.0.2.11');
    } finally {
      allowReturn();
    }
    await expect(success).resolves.toMatchObject({member:{directoryId:'admin'}});
    expect(buckets().get('account:admin')?.failed).toHaveLength(1);
    expect(buckets().get('account:admin')?.pending).toBe(0);
  });

  it('releases reservations when the workspace is unavailable', async () => {
    vi.spyOn(repository, 'transact').mockRejectedValueOnce(new Error('workspace unavailable'));
    await expect(login(source)).rejects.toThrow('workspace unavailable');
    expect(buckets().size).toBe(0);
    await expect(login(source)).resolves.toMatchObject({member:{directoryId:'admin'}});
  });
});
