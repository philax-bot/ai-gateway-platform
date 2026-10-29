import {afterEach,describe,expect,it,vi} from 'vitest';
import {PostgresStore} from './postgres.store';
describe('PostgreSQL idle connection faults',()=>{
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
  it('handles the actual pool event without crashing or logging connection details',async()=>{
    vi.stubEnv('REDIS_URL','');const log=vi.spyOn(console,'error').mockImplementation(()=>{}),store=new PostgresStore();
    const error=Object.assign(new Error('private connection string and password'),{code:'ECONNRESET',client:{password:'private password'}});
    expect(()=>(store as unknown as {pool:{emit:(event:string,error:unknown)=>void}}).pool.emit('error',error)).not.toThrow();
    expect(log).toHaveBeenCalledWith('{"event":"postgres_idle_connection_error","code":"ECONNRESET"}');await store.onModuleDestroy();
  });
});
