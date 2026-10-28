import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { HotPathDiagnostics } from './hot-path-diagnostics';

describe('bounded hot-path diagnostics',()=>{
  it('retains only fixed stage labels and bounded timing samples, including failures',async()=>{
    const diagnostics=new HotPathDiagnostics(true,2);
    const raw={query:async(sql:string)=>{if(sql.includes('fail'))throw new Error('secret failure');return {rows:[]};}} as unknown as PoolClient;
    for(let i=0;i<3;i++){
      const trace=diagnostics.start('authorize'),client=trace.acquired(raw);
      await client.query('select * from credentials where api_key=$1',['private-key']);
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['private-request']);
      await expect(client.query('fail secret SQL')).rejects.toThrow();trace.finish(true);
    }
    const snapshot=diagnostics.snapshot();expect(snapshot).toMatchObject({completed:3,retained:2,dropped:1,operations:{authorize:{samples:2,failures:2,queries:{p50:3}}}});
    expect(Object.keys(snapshot.operations.authorize.stages)).toEqual(['advisory_lock','credentials','other']);
    expect(JSON.stringify(snapshot)).not.toMatch(/private|secret|select|api_key/);
  });
  it('does no wrapping or retention when disabled',()=>{
    const diagnostics=new HotPathDiagnostics(),trace=diagnostics.start('settle'),raw={} as PoolClient;
    expect(trace.acquired(raw)).toBe(raw);trace.finish();expect(diagnostics.snapshot()).toMatchObject({enabled:false,retained:0,completed:0});
  });
});
