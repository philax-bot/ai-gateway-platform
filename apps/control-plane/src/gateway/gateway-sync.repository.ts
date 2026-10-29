import {Injectable} from '@nestjs/common';
import type {GatewaySyncResponse} from '@ai-gateway/contracts';
import {DemoStore} from '../store/demo.store';
import {PostgresStore} from '../store/postgres.store';

export interface SyncOperation {fingerprint:string; binding:string; response:GatewaySyncResponse; leaseUntil:number}
export interface SyncState {
  active?:{binding:string;version:string;name:string};
  latest?:GatewaySyncResponse;
  operations:Record<string,SyncOperation>;
}

@Injectable()
export class GatewaySyncRepository {
  private readonly memory=new Map<string,SyncState>();
  constructor(private readonly store:DemoStore){}
  async read(resourceId:string):Promise<SyncState>{
    if(!(this.store instanceof PostgresStore))return structuredClone(this.memory.get(resourceId)??{operations:{}});
    return this.store.withClient(async client=>(await client.query('select payload from gateway_sync_state where resource_id=$1',[resourceId])).rows[0]?.payload??{operations:{}});
  }
  async active(resourceId:string):Promise<SyncState['active']>{
    if(!(this.store instanceof PostgresStore))return structuredClone(this.memory.get(resourceId)?.active);
    return this.store.withClient(async client=>(await client.query("select payload->'active' as active from gateway_sync_state where resource_id=$1",[resourceId])).rows[0]?.active);
  }
  // Only short state transactions take this lock. Network publication never holds a DB client.
  async change<T>(resourceId:string,work:(state:SyncState)=>T):Promise<T>{
    if(!(this.store instanceof PostgresStore))return this.store.exclusive(async()=>{
      const state=structuredClone(this.memory.get(resourceId)??{operations:{}}),result=work(state);this.memory.set(resourceId,state);return structuredClone(result);
    });
    return this.store.withClient(async client=>{
      await client.query('begin');
      try{
        await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['higress:'+resourceId]);
        const state:SyncState=(await client.query('select payload from gateway_sync_state where resource_id=$1',[resourceId])).rows[0]?.payload??{operations:{}};
        const result=work(state);
        await client.query('insert into gateway_sync_state(resource_id,payload) values($1,$2) on conflict(resource_id) do update set payload=excluded.payload,updated_at=now()',[resourceId,state]);
        await client.query('commit');return result;
      }catch(error){await client.query('rollback');throw error;}
    });
  }
}
