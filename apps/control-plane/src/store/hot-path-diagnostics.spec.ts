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
  it('links a stalled query to its backend and distinguishes it from local work without exposing SQL',async()=>{
    const diagnostics=new HotPathDiagnostics(true,4);let release!:()=>void;
    const gate=new Promise<{rows:unknown[]}>(resolve=>{release=()=>resolve({rows:[]});});
    const raw={processID:8123,query:()=>gate} as unknown as PoolClient;
    const trace=diagnostics.start('workspace_write','monitoring_commit'),client=trace.acquired(raw);
    const query=client.query('update quota_batches set available_amount=$1 where id=$2',[123,'private-batch']);
    const busy=diagnostics.snapshot();expect(busy.active[0]).toMatchObject({operation:'workspace_write',context:'monitoring_commit',backendPid:8123,phase:'query',currentQuery:{stage:'quota_batches',command:'write'}});
    release();await query;
    const local=diagnostics.snapshot();expect(local.active[0]).toMatchObject({phase:'local',currentQuery:null,lastQuery:{stage:'quota_batches',command:'write'}});
    trace.finish();const finished=diagnostics.snapshot();expect(finished.active).toHaveLength(0);expect(finished.slowOperations[0]).toMatchObject({backendPid:8123,queries:1});
    expect(JSON.stringify(finished)).not.toMatch(/private-batch|available_amount|set available|where id/);
    const checkpoint=finished.completed,next=diagnostics.start('settle');next.acquired(raw);next.finish();
    expect(diagnostics.snapshot(checkpoint)).toMatchObject({after:1,retained:1,operations:{workspace_write:{samples:0},settle:{samples:1}}});
  });
  it('bounds in-flight details and statement history as well as completed retention',async()=>{
    const diagnostics=new HotPathDiagnostics(true,2),traces=Array.from({length:150},()=>diagnostics.start('authorize'));
    expect(diagnostics.snapshot().active.length).toBeLessThanOrEqual(128);for(const trace of traces)trace.finish();
    expect(diagnostics.snapshot()).toMatchObject({completed:150,retained:2,dropped:148,active:[]});
    const trace=diagnostics.start('settle'),client=trace.acquired({query:async()=>({rows:[]})} as unknown as PoolClient);
    for(let index=0;index<30;index++)await client.query('select * from reservations where request_id=$1',['private-request']);trace.finish();
    const detail=diagnostics.snapshot(150).slowOperations[0];expect(detail.queries).toBe(30);expect(detail.steps.length).toBeLessThanOrEqual(24);expect(detail.omittedSteps+detail.steps.length).toBe(30);
  });
});
